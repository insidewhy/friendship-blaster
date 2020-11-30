import { AxiosRequestConfig } from "axios";
import Axios from "axios-observable";
import semver from "semver";
import https from "https";
import { Observable, merge, empty } from "rxjs";
import { map, filter, catchError, scan } from "rxjs/operators";

import { TaggedImage, TaggedImages } from "./docker";
import { isDefined, debugLog, switchScan, interruptableInterval } from "./util";
import { AuthConfig } from "./config";

const MAX_CONTAINER_TAGS = 999999999;

/**
 * Poll a single docker image to see if it updates by using the docker registry
 * (v2) /v2/${imageName}/tags/list API that returns all of the tags for an image.
 * Any errors will be logged and ignored to ensure that the pipeline including
 * this observable will not be affected.
 */
function pollImageForUpdates(
  allowInsecureHttps: boolean,
  auth: AuthConfig | undefined,
  pollableImage: TaggedImage,
  pollDueToSignal: boolean,
): Observable<TaggedImage> {
  const tagUrl = `https://${pollableImage.repoUrl}/v2/${pollableImage.image}/tags/list`;
  const axiosOptions: AxiosRequestConfig = {
    params: { n: MAX_CONTAINER_TAGS },
    auth: auth?.get(pollableImage.repoUrl) ?? undefined,
  };

  if (allowInsecureHttps) {
    axiosOptions.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  if (pollDueToSignal) {
    console.log("Polling for update due to signal: %O");
  } else {
    debugLog("Polling for update on schedule: %O", pollableImage);
  }

  // curl -H "Accept: application/json" --user solas:password -L https://solas.azurecr.io/v2/solas-dns/tags/list\?n=9000
  return Axios.get(tagUrl, axiosOptions).pipe(
    map((result) => {
      const tags: string[] = result.data?.tags ?? [];
      const spec = `^${pollableImage.tag}`;
      const nextTag = semver.maxSatisfying(tags, spec);
      if (!nextTag || nextTag === pollableImage.tag) {
        // tag has not changed
        return undefined;
      }

      return {
        ...pollableImage,
        tag: nextTag,
      };
    }),
    filter(isDefined),
    catchError((error) => {
      // just log errors, don't want to bring the poll process down due to
      // a single HTTP failure
      console.warn(
        "Error polling container registry: %O",
        error?.message || error,
      );
      return empty();
    }),
  );
}

/**
 * Poll many images for updates according to the configured poll interval.
 */
function pollImagesForUpdate(
  initialPollableImages: TaggedImages,
  pollFrequency: number,
  allowInsecureHttps: boolean,
  auth?: AuthConfig,
): Observable<TaggedImages> {
  return merge(
    ...initialPollableImages.map((initialPollableImage) =>
      interruptableInterval(pollFrequency * 1000).pipe(
        switchScan(
          pollImageForUpdates.bind(null, allowInsecureHttps, auth),
          // initial value for mergeScan accumulator
          initialPollableImage,
        ),
      ),
    ),
  ).pipe(
    scan((pollableImages: TaggedImages, changedImage: TaggedImage) => {
      // filter out the corresponding entry then push the change
      const newImages = pollableImages.filter(
        (pollableImage) =>
          pollableImage.repoUrl !== changedImage.repoUrl ||
          pollableImage.image !== changedImage.image,
      );
      newImages.push(changedImage);

      return newImages;
    }, initialPollableImages),
  );
}

export default pollImagesForUpdate;
