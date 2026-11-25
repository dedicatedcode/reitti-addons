# Vehicle model attribution

The vehicle GLB models in `assets/` are derived from models published by
[Grab3D](https://grab3d.com/). They are released under
[CC0 1.0 Universal (Public Domain Dedication)](https://creativecommons.org/publicdomain/zero/1.0/),
so attribution is not required, but it is recorded here.

| Model | Source |
| --- | --- |
| City Bus | https://grab3d.com/models/vehicles/city-bus/ |
| Tram | https://grab3d.com/models/vehicles/tram/ |
| Subway Train | https://grab3d.com/models/vehicles/subway-train/ |
| Subway Car | https://grab3d.com/models/vehicles/subway-car/ |
| High-Speed Train | https://grab3d.com/models/vehicles/high-speed-train/ |

Modifications made for this extension:

- rotated to the extension's `-Z` forward axis;
- simplified and texture-resized for use as map markers;
- the tram and subway car ground tracks removed;
- body paint converted to a dark neutral texture for the neutral layers;
- body paint converted to a light greyscale texture for the line-coloured layers.

Kits:

- Cozy Vehicles Kit: https://grab3d.com/kits/cozy-vehicles/
- Cozy Trains & Railway Kit: https://grab3d.com/kits/cozy-trains/
- City Builder Pack: https://grab3d.com/packs/city-builder-pack/

# Transit data attribution

The default regional route-shape supplement is the NAH.SH GTFS feed for
Schleswig-Holstein and Hamburg:

- Publisher: NAH.SH GmbH
- Source: https://opendata.schleswig-holstein.de/dataset/fahrplandaten
- License: CC BY 4.0

Additional regional feeds added through `regions.json` remain under the
license of their respective publishers.
