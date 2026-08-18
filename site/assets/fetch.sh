#!/bin/sh
# Pulls the public-domain historical images the deep-dive page references.
# They aren't committed to keep the repo small; run this once before serving
# site/ locally, or let GitHub Pages serve the page without them (the figure
# degrades to a caption).
set -eu
cd "$(dirname "$0")"

# Frances Griffiths and the Cottingley Fairies, 1917. Elsie Wright, photographer.
# Public domain (published 1917). Source: Wikimedia Commons.
curl -fSL -A 'sourcekit-open/1.0 (https://github.com/noah-pi/sourcekit-open)' \
  -o cottingley.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/a/a5/Cottingley_Fairies_1.jpg'

echo "fetched: $(ls -1 cottingley.jpg)"
