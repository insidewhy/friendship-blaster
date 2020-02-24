from busybox

# this is the same as echo-server, but also has a healthcheck
arg IMAGE_TAG
arg VARIANT

run echo $IMAGE_TAG > /var/image-tag && \
  echo $VARIANT > /var/variant && \
  mkdir /mnt

cmd ["sh", "-c", "cat /var/image-tag >> /mnt/$(cat /var/variant) && exec sleep infinity"]

# returns true when the number of lines in the mounted files matches or exceeds
# the variant (which must be a number)
healthcheck --interval=2s --timeout=3s --start-period=1s \
  cmd /bin/sh -c "test $(cat /mnt/$(cat /var/variant) | wc -l) -ge $(cat /var/variant)"
