# friendship blaster

[![build status](https://circleci.com/gh/ohjames/friendship-blaster.png?style=shield)](https://circleci.com/gh/ohjames/friendship-blaster)
[![Known Vulnerabilities](https://snyk.io/test/github/ohjames/friendship-blaster/badge.svg)](https://snyk.io/test/github/ohjames/friendship-blaster)

This is a tool to run a system of containers using `docker-compose` and update them as new version are published. It works using a master container running `docker-compose`, which schedules sibling containers.

## usage

As input it takes a `docker-compose.yml` and a list of containers that can be upgraded. If the `docker-compose.yml` looks like this:

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

`friendship-blaster` will run the docker-compose configuration file above in a container with `docker-compose` installed. While these containers are running, it will poll the container registry at `some-registry:7420` every one minute to look for updates to `cat-image` and `dog-image` that are above the current version and below the next semantically incompatible version (`11.0.0`). When it detects an update it will do the following in sequence:

- Pull the latest images.
- Shutdown all existing containers.
- Patch the `docker-compose.yml` to refer to the upgraded versions.
- Start all containers.

## Testing

Normally friendship-blaster runs inside of a container and uses a docker-compose and node installed within that container. To decrease wait time during test iterations `yarn test-dev` can be used; this will run friendship-blaster using the system node and docker-compose to avoid the rebuild process which incurs a not insignificant wait.
