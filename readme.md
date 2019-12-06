# friendship blaster

[![build status](https://circleci.com/gh/ohjames/friendship-blaster.png?style=shield)](https://circleci.com/gh/ohjames/friendship-blaster)
[![Known Vulnerabilities](https://snyk.io/test/github/ohjames/friendship-blaster/badge.svg)](https://snyk.io/test/github/ohjames/friendship-blaster)

This is a tool to run a system of docker containers using `docker-compose` and
update them as new image versions are published.

## Usage

As input it takes a `docker-compose.yml` and a list of containers that can be
upgraded. If the `docker-compose.yml` looks like this:

```yaml
version: "3"
services:
  my-cat-service:
    image: some-registry:7420/cat-image:10.0.0
  my-dog-service:
    image: some-registry:7420/dog-image:10.0.0
  redis:
    image: redis:5.0-alpine
```

In the directory containing the `docker-compose.yml` run this:

```bash
friendship-blaster -i dog-image,cat-image
```

`friendship-blaster` will run the docker-compose configuration file above in a
container with `docker-compose` installed. While these containers are running,
it will poll the container registry at `some-registry:7420` every one minute to
look for updates to `cat-image` and `dog-image` that are above the current
version and below the next semantically incompatible version (`11.0.0`). When
it detects an update it will do the following in sequence:

- Pull the latest images.
- Shutdown all existing containers.
- Patch the `docker-compose.yml` to refer to the upgraded versions.
- Start all containers.

## Example

Assume the `docker-compose.yml` exists in the current working directory.

```yaml
version: "3"
services:
  my-cat-service:
    image: some-registry:7420/cat-image:10.0.0
  my-dog-service:
    image: some-registry:7420/dog-image:10.0.0
  redis:
    image: redis:5.0-alpine
```

Next the user runs `friendship-blaster` in this directory:

```bash
friendship-blaster --images dog-image,cat-image \
                   --debounce 100 \
                   --poll-interval 100 \
                   -c credentials.txt
```

This directory must also contain a file called `credentials.txt` which stores
the username and password for the container registry `some-registry:7420` in
the format `username:password`.

When friendship-blaster is first run it runs `docker-compose` using the
`docker-compose.yml` shown above, and every 100 seconds it polls
`some-registry:7420` for changes to `cat-image` and `dog-image`.

120 seconds later the user pushes a new `dog-image` with version `10.0.1`. 200
seconds later `friendship-blaster` will see this image when it next polls.
However it will not restart `docker-compose` immediately due to the requested
`debounce` of 100.

180 seconds later the user pushes a new `cat-image` with version `10.0.2`.
`friendship-blaster` will see this change in its second poll, 200 seconds after
it was first started.

The user does not push any more images for at least 120 seconds, now at 300
seconds the debounce of 100 has cleared. `friendship-blaster` will create a
file `fblaster-docker-compose.yml` in the same directory as
`docker-compose.yml`. This file will be identical to the original except that
the image versions will specify the latest the docker tags that were detected.
It also creates a file `fblaster-versions.yml` in this directory which will
store the reference between the images and their corresponding versions.

Some time later the user decides to shut down `friendship-blaster` by pressing
ctrl-C in the console where it is running. This will in turn cause
`friendship-blaster` to shut down `docker-compose`. Then some time after this
they run `friendship-blaster` in the same directory again. This time
`friendship-blaster` will load the latest `fblaster-versions.yml` and create a
`fblaster-docker-compose.yml` reference the latest tagged docker images. It
will then resume polling for new versions from this point in time.

## Implementation details

`friendship-blaster` runs inside its own container which has `docker-compose`
and `node` installed. The `friendship-blaster` command is a small bash script
which executes the `friendship-blaster` container and mounts
`/var/run/docker.sock` inside of the container. This allows the
`docker-compose` running inside of the container to access docker on the host
system.

## Testing

To decrease the time you must wait for the `friendship-blaster` image to be
rebuilt during testing iterations `yarn test-dev` can be used. This runs
`friendship-blaster` using the versions of `node` and `docker-compose`
installed on the system.
