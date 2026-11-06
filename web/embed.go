package web

import "embed"

// Files contains only assets needed by the browser; the server is a single binary.
//
//go:embed *.html *.js *.css
var Files embed.FS
