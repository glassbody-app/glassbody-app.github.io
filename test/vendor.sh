#!/bin/sh
# Fetch the three CDN libraries into vendor/ and write index.local.html, which
# loads them from disk, with a Content-Security-Policy that allows no other host.
# Tests and offline work use it; both outputs are gitignored. The URLs are the
# pinned ones in index.html. index.local.html registers no service worker: the
# worker's own fetches are not bound by the page's CSP and would still ask cdnjs.
set -eu
cd "$(dirname "$0")/.."
mkdir -p vendor
CDN=https://cdnjs.cloudflare.com/ajax/libs
for lib in three.js/0.160.1/three.min.js d3/7.9.0/d3.min.js jszip/3.10.1/jszip.min.js; do
  out="vendor/$(basename "$lib")"
  [ -s "$out" ] || curl -fsSL "$CDN/$lib" -o "$out"
done
sed -e "s#$CDN/three.js/0.160.1/#vendor/#" \
    -e "s#$CDN/d3/7.9.0/#vendor/#" \
    -e "s#$CDN/jszip/3.10.1/#vendor/#" \
    -e "s#script-src 'self' https://cdnjs.cloudflare.com;#script-src 'self';#" \
    -e '\#<script src="js/sw-register.js"></script>#d' \
    index.html > index.local.html
if grep -q cdnjs index.local.html; then
  echo "index.local.html still points at the CDN; index.html changed shape" >&2
  exit 1
fi
if grep -q 'js/sw-register.js' index.local.html; then
  echo "index.local.html still registers the service worker; index.html changed shape" >&2
  exit 1
fi
echo "vendor/ and index.local.html ready"
