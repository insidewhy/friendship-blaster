from busybox

# this is used to build an image that echos its own image tag
arg IMAGE_TAG
arg VARIANT

run echo $IMAGE_TAG > /var/image-tag && \
  echo $VARIANT > /var/variant && \
  mkdir /mnt

cmd ["sh", "-c", "cat /var/image-tag >> /mnt/$(cat /var/variant) && exec sleep infinity"]
