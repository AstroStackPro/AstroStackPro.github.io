# AstroStackPro

Stack astrophotography frames in your browser. AstroStackPro aligns the stars, rejects satellites, planes and hot pixels, and exports a clean image. Your photos are never uploaded.

It's plain HTML, CSS and JavaScript with no dependencies and no build step, so it runs on GitHub Pages as is.

## Put it on GitHub Pages

1. Create a new repository on GitHub, e.g. `astrostackpro`.
2. Upload everything in this folder (`index.html`, `css/`, `js/`, `.nojekyll`, `README.md`) to the root of the repository.
3. In the repository, go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, then click **Save**.
4. After a minute the app is live at `https://<your-username>.github.io/astrostackpro/`.

To try it locally, just double-click `index.html`. For the fastest median and sigma-clipping runs, serve the folder over HTTP instead, because browsers only allow the private storage cache on http(s) pages:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Speed vs quality

When you add photos, the app times the first one on your machine and shows an estimate for each option before you start.

| Preset | What it does | Use it when |
|---|---|---|
| **Quick look** | Half resolution, one pass, the first photo is the reference, plain average | You want to see the result in seconds |
| **Balanced** | Full resolution. Checks every frame, picks the sharpest as reference, aligns rotation and shift, sigma clipping | The default for a good result |
| **Best quality** | Like Balanced, plus keeps the sharpest 90%, bicubic resampling, winsorized sigma clipping | You have time and want the cleanest image |
| **Star trails** | No alignment, maximum value per pixel | Star-trail images |

**Fine-tune** exposes every setting: stacking method, rejection strength, alignment, resolution, frame selection, resampling, number of stars, worker count, and memory budget.

## Algorithms

- **Star detection:** background grid and noise estimate (MAD), local maxima above 5σ, intensity-weighted centroids. Hot pixels and elongated streaks (satellites, planes, meteors) are ignored.
- **Alignment:**
  - *Rotation and shift*: triangles of neighbouring stars are matched by their shape (as in astroalign), then refined with least squares. This handles the sky's rotation on a fixed tripod.
  - *Shift only*: votes on star-pair offsets.
- **Frame selection:** frames are scored on star count and sharpness (FWHM). Frames that can't be aligned are skipped, and you can keep only the sharpest N%.
- **Stacking**, done in linear light from 8-bit sRGB:
  - *Average* and *Weighted average*: one streaming pass with low memory use.
  - *Maximum*: for star trails.
  - *Median*, *Sigma clipping* (median-centred, iterative) and *Winsorized sigma clipping*: robust methods that remove anything appearing in only a few frames.
- **Robust methods at scale:** aligned frames are written to the browser's private storage (Origin Private File System), then combined in horizontal bands across all CPU cores. Memory stays bounded and each photo is decoded only once. Without that storage, the app re-reads photos for each band, which is slower, and the estimate accounts for it.
- **Finishing:** a 2nd-order light-pollution gradient model with outlier rejection, background neutralisation, black point, brightness, colour-preserving asinh stretch, and saturation. The app also crops edges that not every frame covered.
- **Export:** JPEG, PNG, 16-bit TIFF (processed), or 32-bit float TIFF (linear, unprocessed, for Siril, PixInsight or Photoshop).

## Notes and limits

- **Formats:** JPEG, PNG, WebP and AVIF work everywhere. iPhone **HEIC** works in Safari. In other browsers, export the photos as JPEG ("Most Compatible" in the iPhone camera settings). RAW and FITS are not supported.
- **Landscapes:** aligning on stars blurs a fixed foreground. For images with lots of landscape, stack once with alignment and once without, then blend the two in an editor.
- **Memory:** Chrome and Edge give the best performance. On phones and tablets, use 50% resolution for large photo sets. Safari limits canvases to about 16 megapixels on iOS, so larger photos are scaled to fit.
- **Timings** depend heavily on the machine. On a slow 2-core test machine, 24 × 12 MP photos took 12 s with Quick look, and 12 × 12 MP photos took 35 s with Balanced. More cores scale this almost linearly. Your own estimate is shown before you start.

## Files

```
index.html       page layout
css/style.css    styles
js/core.js       star detection, alignment, warping, pixel rejection (shared with workers)
js/worker.js     background worker: decode, analyse, align, warp, combine
js/post.js       preview, gradient removal, stretch, crop, TIFF writer
js/app.js        UI, presets and time estimates, worker pool, pipeline, export
```
