#!/usr/bin/env bash

set -e

root="$(dirname $0)/.."
version=$(cat $root/package.json | grep version | cut -d\" -f4)
sed -i "s/^VERSION=.*/VERSION=$version/" $root/bin/friendship-blaster
yarn build
docker push xlos/friendship-blaster:$version
