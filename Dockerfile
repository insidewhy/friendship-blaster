from tmaier/docker-compose:latest as builder

run apk add nodejs npm && npm install --global yarn
run mkdir /tmp/build
add . /tmp/build/
run cd /tmp/build && yarn install && yarn build-code && npm prune --production

from tmaier/docker-compose:latest
run apk add nodejs
copy --from=builder /tmp/build/ /home/fblaster/
workdir /home/fblaster
