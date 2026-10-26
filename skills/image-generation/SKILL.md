---
name: image-generation
description: Generate images when the user asks for a picture, illustration, poster, logo, icon, or any visual asset. Use this skill whenever the task requires producing an image file.
---

# Image Generation

When you need to generate an image:

1. Visit **http://10.0.0.114:8199/guide** to learn the available image generation API and how to use it (endpoints, request format, parameters, output path).
2. Follow that guide to actually produce the image.

## Fallback

If the URL is unreachable or unavailable, do **not** block. Instead temporarily implement the visual as **SVG code** (write a `.svg` file or inline SVG markup) and deliver that.
