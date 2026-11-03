#!/usr/bin/env python3
"""Embute o site no Worker (gera worker/src/site.js)."""
import json, os
d = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(d, "worker/site/index.html"), encoding="utf-8").read()
open(os.path.join(d, "worker/src/site.js"), "w", encoding="utf-8").write("export const SITE_HTML = " + json.dumps(html, ensure_ascii=False) + ";\n")
print("site.js gerado:", len(html), "bytes")
