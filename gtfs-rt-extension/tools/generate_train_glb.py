#!/usr/bin/env python3
# Legacy fallback generator. The checked-in bus/tram/train/subway/high-speed
# models are Grab3D-derived; see ../ATTRIBUTION.md before regenerating assets.
import json
import math
import struct
from pathlib import Path

from generate_bus_glb import MATERIALS as BUS_MATERIALS, cube, cylinder, geometry_binary

ROOT = Path(__file__).resolve().parents[1]
MATERIALS = {**BUS_MATERIALS, "accent": [0.72, 0.07, 0.07, 1.0]}


def wedge(front_width=0.82, front_top=0.30, front_bottom=-0.5):
    """A closed frustum with a full-size back and a tapered front."""
    half_front = front_width / 2
    vertices = [
        (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5),
        (-half_front, front_bottom, -0.5), (half_front, front_bottom, -0.5),
        (half_front, front_top, -0.5), (-half_front, front_top, -0.5),
    ]
    faces = [
        (0, 1, 2, 3),
        (4, 5, 6, 7),
        (0, 4, 7, 3),
        (1, 2, 6, 5),
        (3, 7, 6, 2),
        (0, 1, 5, 4),
    ]
    center = tuple(sum(vertex[i] for vertex in vertices) / len(vertices) for i in range(3))
    result = []
    indices = []
    for face in faces:
        points = [vertices[index] for index in face]
        a, b, c = points[:3]
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        face_center = tuple(sum(point[i] for point in points) / len(points) for i in range(3))
        if sum(normal[i] * (face_center[i] - center[i]) for i in range(3)) < 0:
            points.reverse()
            normal = [-value for value in normal]
        length = math.sqrt(sum(value * value for value in normal)) or 1
        normal = [value / length for value in normal]
        start = len(result)
        result.extend((point, normal) for point in points)
        indices.extend((start, start + 1, start + 2, start, start + 2, start + 3))
    return result, indices


class ModelBuilder:
    def __init__(self):
        self.nodes = []
        self.meshes = []
        self.mesh_keys = {}
        self.geometries = {
            "cube": cube(),
            "cylinder": cylinder(),
            "wedge": wedge(),
            "nose": wedge(front_width=0.55, front_top=0.12, front_bottom=-0.28),
        }

    def add(self, name, material, scale, translation, shape="cube", rotation=None):
        key = (shape, material)
        if key not in self.mesh_keys:
            self.mesh_keys[key] = len(self.meshes)
            self.meshes.append({"name": f"{shape}-{material}", "shape": shape,
                                "primitives": [{"material": list(MATERIALS).index(material)}]})
        node = {"name": name, "mesh": self.mesh_keys[key], "scale": scale, "translation": translation}
        if rotation:
            node["rotation"] = rotation
        self.nodes.append(node)

    def windows(self, positions, x, y, width=1.45, height=0.78):
        for side in [-1, 1]:
            for index, z in enumerate(positions):
                self.add(f"window-{side}-{index}", "glass", [0.055, height, width], [side * x, y, z])

    def bogies(self, positions, width=2.3):
        for z in positions:
            self.add("bogie", "shadow", [width, 0.36, 2.2], [0, 0.4, z])
            for side in [-1, 1]:
                for wheel_z in [z - 0.65, z + 0.65]:
                    self.add("rail-wheel", "rubber", [0.34, 0.18, 0.34], [side * (width / 2 - 0.08), 0.36, wheel_z],
                             shape="cylinder", rotation=[0, 0, math.sqrt(0.5), math.sqrt(0.5)])

    def pantograph(self, roof_y, z=2.5):
        self.add("pantograph-base", "metal", [1.4, 0.10, 1.8], [0, roof_y + 0.08, z])
        angle = math.pi / 5
        for side in [-1, 1]:
            self.add("pantograph-arm", "metal", [0.09, 1.9, 0.09], [0, roof_y + 0.85, z + side * 0.45],
                     rotation=[math.sin(side * angle / 2), 0, 0, math.cos(side * angle / 2)])
        self.add("pantograph-contact", "metal", [1.8, 0.08, 0.12], [0, roof_y + 1.65, z])

    def lights(self, front_z, rear_z, y=1.0, x=0.68):
        for side in [-1, 1]:
            self.add("headlight", "light", [0.30, 0.16, 0.06], [side * x, y, front_z])
            self.add("taillight", "accent", [0.26, 0.14, 0.06], [side * x, y, rear_z])

    def write(self, name):
        binary = b""
        views = []
        accessors = []
        geometry_accessors = {}
        for shape, (vertices, indices) in self.geometries.items():
            data, shape_views, shape_accessors = geometry_binary(vertices, indices)
            for view in shape_views:
                view["byteOffset"] = view.get("byteOffset", 0) + len(binary)
            for accessor in shape_accessors:
                accessor["bufferView"] += len(views)
            geometry_accessors[shape] = len(accessors)
            binary += data
            views.extend(shape_views)
            accessors.extend(shape_accessors)
        for mesh in self.meshes:
            first = geometry_accessors[mesh.pop("shape")]
            mesh["primitives"][0].update({"attributes": {"POSITION": first, "NORMAL": first + 1}, "indices": first + 2})
        document = {
            "asset": {"version": "2.0", "generator": "reitti-gtfs-rt-extension"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": [{"name": material, "doubleSided": True, "pbrMetallicRoughness": {
                "baseColorFactor": color, "metallicFactor": 0.0, "roughnessFactor": 0.72,
            }} for material, color in MATERIALS.items()],
            "buffers": [{"byteLength": len(binary)}],
            "bufferViews": views,
            "accessors": accessors,
        }
        json_data = json.dumps(document, separators=(",", ":")).encode()
        json_data += b" " * ((-len(json_data)) % 4)
        binary += b"\0" * ((-len(binary)) % 4)
        output = struct.pack("<4sII", b"glTF", 2, 28 + len(json_data) + len(binary))
        output += struct.pack("<II", len(json_data), 0x4E4F534A) + json_data
        output += struct.pack("<II", len(binary), 0x004E4942) + binary
        (ROOT / "assets" / f"{name}.glb").write_bytes(output)
        print(f"Wrote assets/{name}.glb ({len(output)} bytes, {len(self.nodes)} nodes)")


def regional_train():
    model = ModelBuilder()
    model.add("underframe", "shadow", [2.6, 0.35, 13.8], [0, 0.52, 1.0])
    model.add("body", "body", [2.9, 2.35, 14.0], [0, 1.55, 1.0])
    model.add("sloped-cab", "body", [2.9, 2.35, 4.0], [0, 1.55, -8.0], shape="wedge")
    model.add("roof", "roof", [2.7, 0.16, 13.8], [0, 2.81, 1.0])
    model.add("roof-unit", "metal", [1.4, 0.18, 2.2], [0, 2.90, -1.0])
    model.add("windshield", "glass", [1.6, 0.8, 0.06], [0, 1.92, -10.02])
    model.windows([-4.8, -2.4, 0.0, 2.4, 4.8, 7.0], 1.46, 2.0, width=1.5)
    for side in [-1, 1]:
        for z in [-3.4, 3.4]:
            model.add("door", "metal", [0.06, 1.85, 0.9], [side * 1.47, 1.32, z])
        model.add("stripe", "shadow", [0.04, 0.12, 13.6], [side * 1.46, 0.9, 1.0])
    model.bogies([-4.8, 5.5])
    model.pantograph(2.89, 2.6)
    model.lights(-10.04, 8.02)
    model.add("coupler", "metal", [0.5, 0.25, 0.4], [0, 0.55, -10.15])
    return model


def subway():
    model = ModelBuilder()
    model.add("underframe", "shadow", [2.5, 0.32, 13.8], [0, 0.5, 0])
    model.add("body", "body", [2.8, 2.4, 14.0], [0, 1.55, 0])
    model.add("roof", "roof", [2.65, 0.18, 13.8], [0, 2.84, 0])
    model.add("front-mask", "glass", [2.1, 1.0, 0.06], [0, 1.95, -7.03])
    model.add("rear-window", "glass", [2.1, 0.9, 0.06], [0, 1.95, 7.03])
    model.windows([-5.2, -3.1, -1.0, 1.1, 3.2, 5.3], 1.41, 2.0, width=1.2)
    for side in [-1, 1]:
        for z in [-4.2, 0.0, 4.2]:
            model.add("double-door", "metal", [0.06, 1.85, 0.9], [side * 1.42, 1.32, z])
        model.add("stripe", "shadow", [0.04, 0.12, 13.6], [side * 1.41, 0.9, 0])
    model.bogies([-4.5, 4.5], width=2.15)
    model.add("roof-equipment", "metal", [1.6, 0.25, 3.0], [0, 3.0, 1.2])
    model.lights(-7.05, 7.05, y=0.95, x=0.62)
    return model


def sbahn():
    model = ModelBuilder()
    model.add("underframe", "shadow", [2.6, 0.35, 13.8], [0, 0.52, 1.0])
    model.add("body", "body", [2.9, 2.4, 14.0], [0, 1.55, 1.0])
    model.add("cab", "body", [2.9, 2.4, 4.0], [0, 1.55, -8.0], shape="wedge")
    model.add("roof", "roof", [2.7, 0.16, 13.8], [0, 2.81, 1.0])
    model.add("windshield", "glass", [1.7, 0.85, 0.06], [0, 1.95, -10.02])
    model.windows([-4.6, -2.2, 0.2, 2.6, 5.0, 7.0], 1.46, 2.0, width=1.35)
    for side in [-1, 1]:
        for z in [-3.3, 1.1, 5.5]:
            model.add("door", "metal", [0.06, 1.85, 0.85], [side * 1.47, 1.32, z])
        model.add("stripe", "shadow", [0.04, 0.12, 13.6], [side * 1.46, 0.9, 1.0])
    model.bogies([-4.8, 5.3])
    model.pantograph(2.89, 3.5)
    model.add("roof-unit", "metal", [1.3, 0.18, 2.0], [0, 2.90, -1.2])
    model.lights(-10.04, 8.02)
    return model


def intercity():
    model = ModelBuilder()
    model.add("underframe", "shadow", [2.6, 0.35, 15.8], [0, 0.52, 2.0])
    model.add("body", "body", [2.9, 2.45, 16.0], [0, 1.58, 2.0])
    model.add("cab", "body", [2.9, 2.45, 4.5], [0, 1.58, -8.25], shape="wedge")
    model.add("roof", "roof", [2.7, 0.16, 15.8], [0, 2.88, 2.0])
    model.add("windshield", "glass", [1.7, 0.85, 0.06], [0, 2.0, -10.52])
    model.windows([-4.8, -2.3, 0.2, 2.7, 5.2, 7.7, 9.2], 1.46, 2.05, width=1.5)
    for side in [-1, 1]:
        for z in [-2.0, 5.0]:
            model.add("door", "metal", [0.06, 1.9, 0.95], [side * 1.47, 1.34, z])
        model.add("stripe", "accent", [0.04, 0.14, 15.6], [side * 1.46, 0.95, 2.0])
    model.bogies([-5.0, 7.0])
    model.pantograph(2.96, 3.0)
    model.add("roof-unit", "metal", [1.5, 0.18, 2.4], [0, 2.98, -1.5])
    model.lights(-10.54, 10.02)
    model.add("coupler", "metal", [0.5, 0.25, 0.4], [0, 0.55, -10.65])
    return model


def ice():
    model = ModelBuilder()
    model.add("underframe", "shadow", [2.6, 0.35, 15.0], [0, 0.52, 3.0])
    model.add("body", "body", [2.9, 2.3, 15.0], [0, 1.55, 3.0])
    model.add("aerodynamic-nose", "body", [2.9, 2.3, 8.0], [0, 1.55, -8.5], shape="nose")
    model.add("roof", "roof", [2.7, 0.14, 14.8], [0, 2.77, 3.0])
    model.add("cockpit", "glass", [1.3, 0.55, 0.06], [0, 1.95, -12.52])
    for side in [-1, 1]:
        model.add("window-strip", "glass", [0.055, 0.55, 12.5], [side * 1.46, 2.0, 3.0])
        model.add("stripe", "accent", [0.04, 0.16, 14.8], [side * 1.46, 0.95, 3.0])
    model.bogies([-2.5, 7.5], width=2.2)
    model.add("roof-fairing", "roof", [1.6, 0.16, 5.0], [0, 2.88, 3.0])
    model.add("roof-unit", "metal", [1.2, 0.16, 2.0], [0, 2.98, 0.0])
    model.lights(-12.54, 10.52, y=0.9, x=0.35)
    model.add("coupler", "metal", [0.45, 0.22, 0.35], [0, 0.52, 10.65])
    return model


def main():
    regional_train().write("train")
    subway().write("subway")
    sbahn().write("sbahn")
    intercity().write("ic")
    ice().write("ice")


if __name__ == "__main__":
    main()
