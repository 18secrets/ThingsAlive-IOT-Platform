# Class 3-D models (digital twin)

Each equipment class can carry one `.glb` model. The machine page draws it with a marker
per signal, labelled with the signal's latest value.

## The stand-ins in this folder

`generate_class_models.py` builds a low-poly model for every demo class from boxes and
cylinders, using only the Python standard library:

    python3 scripts/class-models/generate_class_models.py out/

It writes `out/<class-slug>.glb` and `out/manifest.json`, which holds each model's bounding
box and marker positions. To add a class, write a function that builds it, give it
`standard_anchors(...)` (or its own `anchor(...)` calls) and add it to `CLASSES`. The script
exits non-zero if a marker falls outside its model, because the API would refuse it.

These are placeholders with the right silhouette, not CAD. Replace them with real models
when you have them.

## Making a real model

Whatever tool you use, the file has to follow the rules ModelScene relies on. It draws the
file exactly as stored, with no centring and no scaling:

| Rule | Why |
|---|---|
| Binary glTF 2.0 (`.glb`), one file | The upload accepts `.glb` only; textures must be embedded. |
| Metres, Y up, front towards +X, ground at y = 0 | Marker x, y, z are in the model's own units; a model in millimetres puts the camera a kilometre away. |
| Under ~5 MB, ideally under 1 MB | It is fetched on every machine page. Decimate, and compress textures (or use Draco). |
| One model per class, not per machine | Every machine of the class shares it. |

Ways to get one:

- **From a manufacturer.** Many publish STEP or IGES files. Convert them in Blender
  (with the CAD import add-on) or FreeCAD, then decimate.
- **Blender** (free): model or import, apply all transforms (Ctrl+A), set units to
  metres, then File, Export, glTF 2.0, format "glTF Binary (.glb)", with "+Y Up" ticked.
- **Photogrammetry** of the actual machine: Polycam, RealityCapture or Luma. Scale it
  to metres in Blender before exporting.
- **Model marketplaces** (Sketchfab, CGTrader, TurboSquid): check the licence allows
  commercial use.

Check a file before uploading by dropping it on https://gltf-viewer.donmccurdy.com
(its size and orientation show at once) and https://github.khronos.org/glTF-Validator.

## Putting it on a class

Admin console, then Catalog, then the class, then **3-D model**, on a draft version:
upload the `.glb` (the console measures its box), click the model to place each signal's
marker, save, and publish the version. Accounts pick it up when they upgrade to that
version; markers an account moved itself are kept, and are flagged for a recheck if the
geometry changed under them.
