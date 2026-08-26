#!/bin/sh
# Source Kit 0.1.0 — fetches the images the site uses
# Pulls the public-domain historical image the deep-dive page references.
#
# The binary isn't committed, so run this before serving site/ locally. The
# Pages workflow runs it too, but never fails the build on it: if the image
# can't be fetched the figure degrades to a caption and the page still ships.
#
# Special:FilePath resolves the current storage path for a file title, which
# is the supported way to link one — never hand-build an upload.wikimedia.org
# hash path.
set -u
cd "$(dirname "$0")"

UA='sourcekit-open/1.0 (https://github.com/noah-pi/sourcekit-open)'
TITLE='Cottingley_Fairies_1.jpg'

for host in commons.wikimedia.org en.wikipedia.org; do
  if curl -fSL --max-time 30 -A "$UA" \
       -o cottingley.jpg "https://$host/wiki/Special:FilePath/$TITLE"; then
    # A redirect to an error page would leave us with HTML, not a JPEG.
    case "$(file -b --mime-type cottingley.jpg 2>/dev/null)" in
      image/*) echo "fetched cottingley.jpg from $host"; exit 0 ;;
    esac
    echo "warning: $host returned a non-image for $TITLE" >&2
    rm -f cottingley.jpg
  fi
done

echo "warning: could not fetch $TITLE; the page will render the caption instead" >&2
exit 0
