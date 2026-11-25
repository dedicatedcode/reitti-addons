#!/usr/bin/env python3
# Legacy fallback generator. The checked-in bus/tram/train/subway/high-speed
# models are Grab3D-derived; see ../ATTRIBUTION.md before regenerating assets.
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MATERIALS = {
    "body": [0.86, 0.88, 0.90, 1.0],
    "roof": [0.42, 0.45, 0.49, 1.0],
    "glass": [0.025, 0.045, 0.065, 1.0],
    "rubber": [0.02, 0.025, 0.03, 1.0],
    "metal": [0.34, 0.37, 0.41, 1.0],
    "shadow": [0.035, 0.045, 0.055, 1.0],
    "light": [1.0, 0.92, 0.55, 1.0],
    "red": [0.72, 0.07, 0.07, 1.0],
}


def cube():
    vertices = []
    indices = []
    faces = [
        ((1, 0, 0), [(0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (0.5, 0.5, 0.5), (0.5, -0.5, 0.5)]),
        ((-1, 0, 0), [(-0.5, -0.5, 0.5), (-0.5, 0.5, 0.5), (-0.5, 0.5, -0.5), (-0.5, -0.5, -0.5)]),
        ((0, 1, 0), [(-0.5, 0.5, -0.5), (-0.5, 0.5, 0.5), (0.5, 0.5, 0.5), (0.5, 0.5, -0.5)]),
        ((0, -1, 0), [(-0.5, -0.5, 0.5), (-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, -0.5, 0.5)]),
        ((0, 0, 1), [(-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5)]),
        ((0, 0, -1), [(0.5, -0.5, -0.5), (-0.5, -0.5, -0.5), (-0.5, 0.5, -0.5), (0.5, 0.5, -0.5)]),
    ]
    for normal, points in faces:
        start = len(vertices)
        vertices.extend((point, normal) for point in points)
        indices.extend((start, start + 1, start + 2, start, start + 2, start + 3))
    return vertices, indices


def cylinder(segments=12):
    vertices = []
    indices = []
    for y, normal_y in [(0.5, 1), (-0.5, -1)]:
        center = len(vertices)
        vertices.append(((0, y, 0), (0, normal_y, 0)))
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            vertices.append(((math.cos(angle), y, math.sin(angle)), (0, normal_y, 0)))
        for i in range(segments):
            a = center + 1 + i
            b = center + 1 + (i + 1) % segments
            indices.extend((center, a, b) if normal_y > 0 else (center, b, a))
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        p0 = (math.cos(a0), math.sin(a0))
        p1 = (math.cos(a1), math.sin(a1))
        normal = (math.cos((a0 + a1) / 2), 0, math.sin((a0 + a1) / 2))
        start = len(vertices)
        vertices.extend([
            ((p0[0], -0.5, p0[1]), normal), ((p1[0], -0.5, p1[1]), normal),
            ((p1[0], 0.5, p1[1]), normal), ((p0[0], 0.5, p0[1]), normal),
        ])
        indices.extend((start, start + 1, start + 2, start, start + 2, start + 3))
    return vertices, indices


def geometry_binary(vertices, indices):
    positions = b"".join(struct.pack("<3f", *point) for point, _ in vertices)
    normals = b"".join(struct.pack("<3f", *normal) for _, normal in vertices)
    index_data = b"".join(struct.pack("<H", index) for index in indices)
    chunks = []
    accessors = []
    views = []
    offset = 0
    for data, target in [(positions, 34962), (normals, 34962), (index_data, 34963)]:
        padding = (-offset) % 4
        chunks.append(b"\0" * padding)
        offset += padding
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        chunks.append(data)
        offset += len(data)
    points = [point for point, _ in vertices]
    accessors.extend([
        {"bufferView": 0, "componentType": 5126, "count": len(vertices), "type": "VEC3",
         "min": [min(p[i] for p in points) for i in range(3)], "max": [max(p[i] for p in points) for i in range(3)]},
        {"bufferView": 1, "componentType": 5126, "count": len(vertices), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
    ])
    return b"".join(chunks), views, accessors


def main():
    nodes = []
    meshes = []
    for name in MATERIALS:
        meshes.append({
            "name": name,
            "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": len(meshes)}],
        })

    def box(name, material, scale, translation):
        nodes.append({"name": name, "mesh": list(MATERIALS).index(material), "scale": scale, "translation": translation})

    box("chassis", "shadow", [2.3, 0.3, 9.6], [0, 0.5, 0])
    box("body", "body", [2.5, 2.3, 10.0], [0, 1.55, 0])
    box("roof", "roof", [2.42, 0.16, 9.8], [0, 2.78, 0])
    box("roof-unit", "metal", [1.25, 0.16, 2.1], [0, 2.92, 1.1])
    box("windshield", "glass", [2.18, 0.95, 0.06], [0, 1.95, -5.03])
    box("rear-window", "glass", [2.18, 0.8, 0.06], [0, 1.95, 5.03])
    box("window-band-left", "glass", [0.055, 0.8, 8.7], [-1.275, 2.0, 0.2])
    box("window-band-right", "glass", [0.055, 0.8, 8.7], [1.275, 2.0, 0.2])
    for side in [-1, 1]:
        for z in [-2.8, 2.8]:
            box("door", "metal", [0.06, 1.8, 0.9], [side * 1.26, 1.35, z])
        box("headlight", "light", [0.34, 0.18, 0.06], [side * 0.8, 0.88, -5.03])
        box("taillight", "red", [0.3, 0.18, 0.06], [side * 0.8, 0.88, 5.03])
    for z in [-5.0, 5.0]:
        box("bumper", "metal", [2.42, 0.26, 0.22], [0, 0.52, z])

    cube_data, views, accessors = geometry_binary(*cube())
    cylinder_data, cylinder_views, cylinder_accessors = geometry_binary(*cylinder())
    for view in cylinder_views:
        view["byteOffset"] = view.get("byteOffset", 0) + len(cube_data)
    for accessor in cylinder_accessors:
        accessor["bufferView"] += len(views)
    meshes.append({
        "name": "wheel",
        "primitives": [{"attributes": {"POSITION": len(accessors), "NORMAL": len(accessors) + 1},
                        "indices": len(accessors) + 2, "material": list(MATERIALS).index("rubber")}],
    })
    wheel_mesh = len(meshes) - 1
    for x in [-1.25, 1.25]:
        for z in [-3.2, 3.2]:
            nodes.append({
                "name": "wheel", "mesh": wheel_mesh,
                "translation": [x, 0.44, z], "scale": [0.44, 0.24, 0.44],
                "rotation": [0, 0, math.sqrt(0.5), math.sqrt(0.5)],
            })

    binary = cube_data + cylinder_data
    document = {
        "asset": {"version": "2.0", "generator": "reitti-gtfs-rt-extension"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [{"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": color, "metallicFactor": 0.0, "roughnessFactor": 0.75,
        }} for name, color in MATERIALS.items()],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views + cylinder_views,
        "accessors": accessors + cylinder_accessors,
    }
    json_data = json.dumps(document, separators=(",", ":")).encode()
    json_data += b" " * ((-len(json_data)) % 4)
    binary += b"\0" * ((-len(binary)) % 4)
    output = struct.pack("<4sII", b"glTF", 2, 28 + len(json_data) + len(binary))
    output += struct.pack("<II", len(json_data), 0x4E4F534A) + json_data
    output += struct.pack("<II", len(binary), 0x004E4942) + binary
    (ROOT / "assets" / "bus.glb").write_bytes(output)
    print(f"Wrote assets/bus.glb ({len(output)} bytes, {len(nodes)} nodes)")


if __name__ == "__main__":
    main()
