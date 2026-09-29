import {
  VESSEL_IDS,
  type VesselGeometryDescriptor,
  type VesselId,
  type VesselResolution,
} from "./types.ts";

type AnyRecord = Record<string, unknown>;

function detail(
  d: string,
  className: VesselGeometryDescriptor["detailPaths"][number]["className"] = "glass-detail",
  fill = "none",
  stroke = "#A2BCC7",
  strokeWidth = 1,
  opacity = 0.6,
) {
  return Object.freeze({ d, className, fill, stroke, strokeWidth, opacity });
}

function facet(d: string, opacity = 0.8) {
  return detail(d, "glass-detail", "facet", "none", 0, opacity);
}

function shine(d: string, opacity = 0.85) {
  return detail(d, "glass-highlight", "shine", "none", 0, opacity);
}

function glint(d: string, opacity = 0.6, strokeWidth = 1) {
  return detail(d, "glass-highlight", "none", "#F3FCFF", strokeWidth, opacity);
}

function base(d: string) {
  return detail(d, "glass-base", "base", "none", 0, 1);
}

// These helpers receive only the finite, source-controlled numbers below.
// A closed ring gives the mouth depth without covering its transparent opening.
function rim(left: number, right: number, y: number, depth: number) {
  const center = (left + right) / 2;
  const ellipse = (l: number, r: number, h: number) => {
    const reach = Math.round((r - l) * 0.276 * 1000) / 1000;
    const shoulder = Math.round(h * 0.66 * 1000) / 1000;
    return `M ${l} ${y} C ${l} ${y - shoulder} ${center - reach} ${y - h} ${center} ${y - h} C ${center + reach} ${y - h} ${r} ${y - shoulder} ${r} ${y} C ${r} ${y + shoulder} ${center + reach} ${y + h} ${center} ${y + h} C ${center - reach} ${y + h} ${l} ${y + shoulder} ${l} ${y} Z`;
  };
  return `${ellipse(left, right, depth)} ${ellipse(left + 3, right - 3, depth / 2)}`;
}

function pedestal(bowlY: number, footY: number, halfFoot: number, halfStem = 3.5) {
  return [
    detail(
      `M ${80 - halfFoot} ${footY} C ${80 - halfFoot} ${footY - 2.3} 64 ${footY - 3.5} 80 ${footY - 3.5} C 96 ${footY - 3.5} ${80 + halfFoot} ${footY - 2.3} ${80 + halfFoot} ${footY} C ${80 + halfFoot} ${footY + 2.3} 96 ${footY + 3.5} 80 ${footY + 3.5} C 64 ${footY + 3.5} ${80 - halfFoot} ${footY + 2.3} ${80 - halfFoot} ${footY} Z`,
      "glass-base",
      "base",
      "#95B0BE",
      0.8,
      0.95,
    ),
    detail(
      `M ${80 - halfStem} ${bowlY - 1} Q 80 ${bowlY + 1} ${80 + halfStem} ${bowlY - 1} L ${80 + halfStem - 0.8} ${footY - 10} Q ${80 + halfStem} ${footY - 4} 93 ${footY - 1} Q 80 ${footY + 1} 67 ${footY - 1} Q ${80 - halfStem} ${footY - 4} ${80 - halfStem + 0.8} ${footY - 10} Z`,
      "glass-stem",
      "glass",
      "#A3BDCA",
      0.85,
      0.9,
    ),
    glint(`M ${79 - halfStem / 2} ${bowlY + 5} L ${79 - halfStem / 2} ${footY - 10}`, 0.55, 1.25),
    glint(
      `M ${85 - halfFoot} ${footY} C 63 ${footY + 2.8} 96 ${footY + 2.8} ${75 + halfFoot} ${footY}`,
      0.7,
      1,
    ),
  ];
}

/**
 * Sculpted, source-controlled vessel artwork. The liquid clip describes only
 * the true interior; stems, handles and hardware live behind it, while facets,
 * reflections and heavy bases sit in front. Paint tokens resolve to gradients
 * owned by each SVG instance, never to a caller-provided URL.
 */
const GEOMETRY: Record<VesselId, VesselGeometryDescriptor> = {
  corny_keg: {
    id: "corny_keg",
    token: "vessel/corny-keg",
    bodyPath:
      "M 47 49 C 38 49 32 57 32 69 V 211 C 32 222 41 228 80 228 C 119 228 128 222 128 211 V 69 C 128 57 122 49 113 49 Z",
    clipPath: "M 70 70 Q 80 67 90 70 V 207 Q 90 214 80 214 Q 70 214 70 207 Z",
    rimPath:
      "M 37 49 C 48 44 112 44 123 49 L 124 57 C 104 62 56 62 36 57 Z M 41 50 C 60 47 100 47 119 50 C 100 54 60 54 41 50 Z",
    viewBox: "0 0 160 250",
    topY: 68.5,
    bottomY: 214,
    fillX: 68,
    fillWidth: 24,
    detailPaths: [
      detail(
        "M 47 49 C 38 49 32 57 32 69 V 211 C 32 222 41 228 80 228 C 119 228 128 222 128 211 V 69 C 128 57 122 49 113 49 Z",
        "glass-detail",
        "metal",
        "#617C8C",
        1.2,
        1,
      ),
      detail(
        "M 35 26 Q 36 17 47 16 H 113 Q 124 17 125 26 L 127 48 Q 125 55 117 55 H 43 Q 35 54 33 48 Z",
        "glass-detail",
        "#17232E",
        "#536B7A",
        1.1,
        1,
      ),
      detail(
        "M 43 25 H 65 Q 69 25 69 29 V 37 H 41 V 29 Q 41 25 43 25 Z M 95 25 H 117 Q 119 25 119 29 V 37 H 91 V 29 Q 91 25 95 25 Z",
        "glass-detail",
        "#000000",
        "#637B89",
        0.8,
        1,
      ),
      detail(
        "M 62 43 V 36 Q 62 32 67 32 H 93 Q 98 32 98 36 V 43 Z",
        "glass-detail",
        "metal",
        "#8BA4B2",
        0.8,
        1,
      ),
      detail(
        "M 46 17 V 10 Q 50 6 55 10 V 17 Z M 105 17 V 10 Q 110 6 114 10 V 17 Z",
        "glass-detail",
        "metal",
        "#9BAFBA",
        1,
        1,
      ),
      detail(
        "M 77 35 Q 80 32 83 35 V 41 Q 80 44 77 41 Z",
        "glass-detail",
        "#17232E",
        "#C0D0D8",
        1,
        1,
      ),
      detail(
        "M 65 68 Q 65 63 80 63 Q 95 63 95 68 V 211 Q 95 219 80 219 Q 65 219 65 211 Z",
        "glass-detail",
        "#0B1722",
        "#5E7786",
        1,
        1,
      ),
      detail(
        "M 32 218 Q 80 232 128 218 L 126 238 Q 124 244 117 244 H 43 Q 36 244 34 238 Z",
        "glass-base",
        "#17232E",
        "#526977",
        1,
        1,
      ),
      detail(
        "M 39 237 H 56 V 247 H 41 Z M 104 237 H 121 L 119 247 H 104 Z",
        "glass-base",
        "#101B25",
        "none",
        0,
        1,
      ),
    ],
    frontPaths: [
      shine("M 40 69 Q 43 65 47 66 L 47 206 Q 43 216 39 206 Z", 0.46),
      detail("M 116 68 V 210", "glass-highlight", "none", "#D6E5ED", 1.4, 0.35),
      detail(
        "M 36 78 Q 47 83 61 83 M 99 83 Q 113 83 124 78 M 36 196 Q 47 201 61 201 M 99 201 Q 113 201 124 196",
        "glass-detail",
        "none",
        "#5F7D8D",
        2.5,
        0.65,
      ),
      glint(
        "M 37 76 Q 48 81 61 81 M 99 81 Q 112 81 123 76 M 37 194 Q 48 199 61 199 M 99 199 Q 112 199 123 194",
        0.4,
        0.75,
      ),
      detail(
        "M 68 71 Q 68 67 80 67 Q 92 67 92 71 V 207 Q 92 216 80 216 Q 68 216 68 207 Z",
        "glass-detail",
        "none",
        "#A2BAC6",
        1.1,
        0.8,
      ),
      shine("M 72 73 H 75 V 205 Q 75 210 72 209 Z", 0.6),
      glint(
        "M 88 85 H 92 M 86 108 H 92 M 88 131 H 92 M 86 154 H 92 M 88 177 H 92 M 86 200 H 92",
        0.85,
        0.9,
      ),
      glint("M 42 225 Q 80 234 118 225", 0.26, 0.85),
    ],
  },
  pint_glass: {
    id: "pint_glass",
    token: "vessel/pint-glass",
    bodyPath:
      "M 42 45 C 42 42 59 40.5 80 40.5 C 101 40.5 118 42 118 45 L 107 216 C 106.6 222 96 225 80 225 C 64 225 53.4 222 53 216 Z",
    clipPath:
      "M 45 45 C 45 43.5 61 43 80 43 C 99 43 115 43.5 115 45 L 103.6 215 C 103.2 219 93 220.5 80 220.5 C 67 220.5 56.8 219 56.4 215 Z",
    rimPath: rim(42, 118, 45, 4.5),
    viewBox: "0 40 160 190",
    topY: 43,
    bottomY: 220.5,
    fillX: 42,
    fillWidth: 76,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 59 54 Q 65 52 71 54 L 74 212 Q 69 219 62 215 Z M 89 54 Q 96 52 102 54 L 97 213 Q 90 218 85 214 Z",
        0.45,
      ),
      shine("M 47 54 Q 51 52 55 54 L 61 202 Q 60 212 57 211 Z"),
      glint("M 48.5 56 L 52 115 M 53 126 L 54 145", 0.65, 1.25),
      glint("M 113 54 L 102.5 209", 0.32, 1.5),
      base("M 55 212 C 61 219 98 219 105 212 L 104.7 217 C 101 222 59 222 55.3 217 Z"),
      glint("M 59 219 Q 80 224 101 219", 0.75, 1.2),
      glint("M 44 44 C 50 41 107 41 116 44", 0.7, 0.8),
    ],
  },
  tulip_glass: {
    id: "tulip_glass",
    token: "vessel/tulip-glass",
    bodyPath:
      "M 49 42 C 49 38.5 63 36.5 80 36.5 C 97 36.5 111 38.5 111 42 C 105 54 100 66 103 77 C 113 93 122 118 113 139 C 108 153 95 169 80 172 C 65 169 52 153 47 139 C 38 118 47 93 57 77 C 60 66 55 54 49 42 Z",
    clipPath:
      "M 53 42 C 53 40.5 65 39.5 80 39.5 C 95 39.5 107 40.5 107 42 C 101 57 97 66 100 78 C 111 96 118 118 110 137 C 104 152 91 165.5 80 166.5 C 69 165.5 56 152 50 137 C 42 118 49 96 60 78 C 63 66 59 57 53 42 Z",
    rimPath: rim(49, 111, 42, 5.5),
    viewBox: "0 35 160 205",
    topY: 39.5,
    bottomY: 166.5,
    fillX: 40,
    fillWidth: 80,
    detailPaths: pedestal(172, 233, 33),
    frontPaths: [
      facet(
        "M 63 82 C 54 106 54 137 76 160 C 61 157 50 140 49 126 C 47 108 55 91 63 82 Z M 99 83 C 111 106 115 131 97 151 C 106 133 100 105 99 83 Z",
        0.8,
      ),
      shine(
        "M 53 47 Q 58 47 61 48 C 66 63 67 72 61 85 C 50 107 49 125 58 141 C 43 131 44 109 55 83 C 61 69 58 59 53 47 Z",
      ),
      glint("M 56 50 Q 64 69 58 82 C 51 96 48 108 49 118", 0.58, 1.2),
      glint("M 108 94 C 117 120 111 139 97 153", 0.35, 1.45),
      base("M 63 155 Q 80 170 97 155 Q 91 168 80 170 Q 69 168 63 155 Z"),
      glint("M 66 161 Q 80 174 94 161", 0.6, 0.85),
      glint("M 51 41 C 58 37 101 37 109 41", 0.75, 0.9),
    ],
  },
  wheat_glass: {
    id: "wheat_glass",
    token: "vessel/wheat-glass",
    bodyPath:
      "M 43 32 C 43 28.5 59 26 80 26 C 101 26 117 28.5 117 32 C 126 64 120 95 111 124 C 103 147 96 167 98 187 L 104 213 C 108 222 95 223 80 223 C 65 223 52 222 56 213 L 62 187 C 64 167 57 147 49 124 C 40 95 34 64 43 32 Z",
    clipPath:
      "M 47 32 C 47 30 62 29 80 29 C 98 29 113 30 113 32 C 122 66 115 96 107 123 C 99 147 92 168 95 188 L 99 210 Q 101 217.5 80 217.5 Q 59 217.5 61 210 L 65 188 C 68 168 61 147 53 123 C 45 96 38 66 47 32 Z",
    rimPath: rim(43, 117, 32, 6),
    viewBox: "0 25 160 200",
    topY: 29,
    bottomY: 217.5,
    fillX: 35,
    fillWidth: 90,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 59 42 C 52 81 62 119 72 151 L 73 206 Q 71 214 67 211 L 71 182 C 70 148 46 92 52 45 Z M 99 42 C 105 88 93 128 88 157 L 88 208 Q 91 213 95 210 C 82 177 109 95 106 44 Z",
        0.5,
      ),
      shine("M 47 42 Q 52 40 55 43 C 48 81 58 118 65 139 C 51 123 41 78 47 42 Z"),
      glint("M 48 46 C 43 65 46 91 52 113", 0.65, 1.2),
      glint("M 115 42 C 122 91 99 143 96 170", 0.38, 1.2),
      base("M 60 210 Q 80 221 100 210 L 101 216 Q 99 221 80 221 Q 61 221 59 216 Z"),
      glint("M 62 217 Q 80 222 98 217", 0.75, 1.1),
      glint("M 45 31 C 54 27 106 27 115 31", 0.75, 0.9),
    ],
  },
  mug: {
    id: "mug",
    token: "vessel/mug",
    bodyPath:
      "M 40 55 C 40 50.9 57.9 48.8 80 48.8 C 102.1 48.8 120 50.9 120 55 L 117.4 210 C 117.3 216.8 103 220 80 220 C 57 220 42.7 216.8 42.6 210 Z",
    clipPath:
      "M 44 55 C 44 52.8 60 51.5 80 51.5 C 100 51.5 116 52.8 116 55 L 113.7 208 C 113.65 212.8 100 215 80 215 C 60 215 46.35 212.8 46.3 208 Z",
    rimPath:
      "M 40 55 C 40 50.9 57.9 48.8 80 48.8 C 102.1 48.8 120 50.9 120 55 C 120 59.1 102.1 61.2 80 61.2 C 57.9 61.2 40 59.1 40 55 Z M 44.5 55 C 44.5 57.1 60.4 58.5 80 58.5 C 99.6 58.5 115.5 57.1 115.5 55 C 115.5 52.9 99.6 51.5 80 51.5 C 60.4 51.5 44.5 52.9 44.5 55 Z",
    viewBox: "0 45 160 180",
    topY: 51.5,
    bottomY: 215,
    fillX: 35,
    fillWidth: 90,
    detailPaths: [
      detail(
        "M 117 76 H 121 C 135 76 142 86 142 102 V 157 C 142 175 134 185 118 185 V 171 H 121 C 128 171 132 166 132 156 V 104 C 132 94 128 90 121 90 H 117 Z",
        "glass-detail",
        "handle",
        "#96ADB8",
        1.2,
        1,
      ),
      glint("M 121 79 C 133 79 139 88 139 103 V 155 C 139 170 133 181 121 181", 0.65, 1.2),
      detail(
        "M 122 93 C 127 93 130 96 130 106 V 154 C 130 163 128 167 122 168",
        "glass-detail",
        "none",
        "#4E6978",
        1.8,
        0.57,
      ),
      glint("M 137.8 106 V 137", 0.7, 1.8),
    ],
    frontPaths: [
      facet(
        "M 56 66 Q 62.5 63 69 66 L 69.5 201 Q 69.5 210 63 210 Q 56.5 210 56.5 201 Z M 75 65 Q 81 63 87 65 L 87 203 Q 87 212 81 212 Q 75 212 75 203 Z M 94 66 Q 100 63 106 66 L 105.4 201 Q 105.4 210 99.5 210 Q 93.6 210 93.6 201 Z",
        1,
      ),
      glint(
        "M 57 69 L 57.5 197 Q 57.5 205 61 206 M 76 68 V 200 Q 76 208 80 209 M 95 69 L 94.6 199 Q 94.6 206 98 207",
        0.2,
        0.7,
      ),
      shine("M 45.8 64 C 47.3 63 50.8 63 53.3 64 L 52.6 187 C 52.6 196 50.3 201 48.3 200 Z", 1),
      glint("M 46.8 66 L 47.7 125", 0.66, 1.5),
      glint("M 47.9 134 L 48.3 150", 0.43, 1.1),
      glint("M 112.3 65 L 110.5 199", 0.28, 2.5),
      glint("M 117.7 64 L 115.4 207", 0.47, 0.85),
      glint("M 41.8 66 L 44.3 208", 0.3, 0.7),
      base(
        "M 44.6 207 C 48 213 63 215 80 215 C 97 215 112 213 115.4 207 L 115.2 212 C 112.5 217.4 98 218.7 80 218.7 C 62 218.7 47.5 217.4 44.8 212 Z",
      ),
      glint("M 47.5 214 C 62 219.2 100 219.2 112.5 214", 0.68, 1.25),
      glint("M 53 215.2 Q 63 217.5 73 217.4", 0.78, 1.15),
      glint("M 41 54.4 C 43 51.2 61 49.8 80 49.8 C 99 49.8 117 51.2 119 54.4", 0.78, 0.9),
      glint("M 42 56.8 C 52 61.8 108 61.8 118 56.8", 0.6, 1.2),
      glint("M 46 54.5 Q 57 52.3 69 52.2", 0.8, 0.75),
    ],
  },
  stout_glass: {
    id: "stout_glass",
    token: "vessel/stout-glass",
    bodyPath:
      "M 48 47 C 48 43.5 62 41.5 80 41.5 C 98 41.5 112 43.5 112 47 C 121 75 122 105 110 140 C 104 159 99 180 101 211 Q 106 223 80 223 Q 54 223 59 211 C 61 180 56 159 50 140 C 38 105 39 75 48 47 Z",
    clipPath:
      "M 52 47 C 52 45.5 64 44.5 80 44.5 C 96 44.5 108 45.5 108 47 C 118 79 116 106 106 139 C 99 162 95 181 97 210 Q 99 217.5 80 217.5 Q 61 217.5 63 210 C 65 181 61 162 54 139 C 44 106 42 79 52 47 Z",
    rimPath: rim(48, 112, 47, 5.5),
    viewBox: "0 40 160 185",
    topY: 44.5,
    bottomY: 217.5,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 61 58 C 55 88 57 116 67 148 C 73 169 73 191 70 209 Q 66 216 65 210 C 70 163 49 127 50 94 Q 50 71 54 59 Z M 99 60 C 110 105 93 149 91 188 L 92 210 Q 97 213 97 206 C 94 157 116 112 108 61 Z",
        0.58,
      ),
      shine("M 51 57 Q 55 55 58 57 C 50 84 50 109 58 130 C 45 122 43 85 51 57 Z"),
      glint("M 51 61 C 47 75 47 94 49 110", 0.7, 1.25),
      glint("M 112 60 C 120 98 105 133 100 163", 0.34, 1.3),
      base("M 62 209 Q 80 221 98 209 L 99 216 Q 95 221 80 221 Q 65 221 61 216 Z"),
      glint("M 65 217 Q 80 222 95 217", 0.7, 1.15),
      glint("M 50 46 C 56 42 104 42 110 46", 0.75, 0.8),
    ],
  },
  snifter: {
    id: "snifter",
    token: "vessel/snifter",
    bodyPath:
      "M 54 55 C 54 51.5 66 49 80 49 C 94 49 106 51.5 106 55 C 116 72 129 96 128 121 C 127 153 105 175 80 179 C 55 175 33 153 32 121 C 31 96 44 72 54 55 Z",
    clipPath:
      "M 58 55 C 58 53 68 52 80 52 C 92 52 102 53 102 55 C 112 74 125 97 124 121 C 123 150 102 170 80 174 C 58 170 37 150 36 121 C 35 97 48 74 58 55 Z",
    rimPath: rim(54, 106, 55, 6),
    viewBox: "0 45 160 180",
    topY: 52,
    bottomY: 174,
    fillX: 30,
    fillWidth: 100,
    detailPaths: pedestal(179, 218, 40, 4.5),
    frontPaths: [
      facet(
        "M 62 65 C 48 99 48 139 74 167 C 52 158 40 136 42 115 C 43 96 52 77 62 65 Z M 105 77 C 130 115 114 153 92 165 C 107 140 108 110 105 77 Z",
        0.65,
      ),
      shine("M 55 66 Q 59 63 63 65 C 43 97 39 117 47 142 C 34 134 35 103 55 66 Z"),
      glint("M 55 71 C 43 92 39 107 40 121", 0.68, 1.3),
      glint("M 113 81 C 132 119 116 150 103 158", 0.36, 1.4),
      base("M 56 161 Q 80 181 104 161 Q 94 175 80 177 Q 66 175 56 161 Z"),
      glint("M 66 171 Q 80 178 94 171", 0.67, 0.9),
      glint("M 56 54 C 62 50 98 50 104 54", 0.75, 0.9),
    ],
  },
  nonic_pint: {
    id: "nonic_pint",
    token: "vessel/nonic-pint",
    bodyPath:
      "M 44 47 C 44 43.5 60 41.5 80 41.5 C 100 41.5 116 43.5 116 47 L 114 72 C 114 78 123 80 123 88 C 123 95 117 100 114 105 L 107 216 C 106 222 96 225 80 225 C 64 225 54 222 53 216 L 46 105 C 43 100 37 95 37 88 C 37 80 46 78 46 72 Z",
    clipPath:
      "M 48 47 C 48 45.5 62 44.5 80 44.5 C 98 44.5 112 45.5 112 47 L 110.5 73 C 110.5 81 119 83 119 88 C 119 94 114 97 110.5 104 L 103.5 215 C 103 219 92 220.5 80 220.5 C 68 220.5 57 219 56.5 215 L 49.5 104 C 46 97 41 94 41 88 C 41 83 49.5 81 49.5 73 Z",
    rimPath: rim(44, 116, 47, 5.5),
    viewBox: "0 40 160 190",
    topY: 44.5,
    bottomY: 220.5,
    fillX: 36,
    fillWidth: 88,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 59 55 H 69 L 70 213 Q 68 219 62 215 L 55 103 Q 49 89 56 81 Z M 94 55 H 103 L 105 78 Q 114 89 106 103 L 98 215 Q 91 219 89 214 Z",
        0.45,
      ),
      shine(
        "M 49 56 Q 53 54 56 56 L 55 75 C 53 83 46 84 46 89 Q 46 96 53 101 L 60 205 Q 58 211 56 206 L 49 104 C 38 93 39 86 47 78 Z",
      ),
      glint("M 49 59 L 48 73 C 48 81 41 82 41 88 Q 41 95 48 101", 0.62, 1.15),
      glint("M 115 80 C 128 88 116 99 113 103 L 106 205", 0.36, 1.2),
      glint("M 43 91 Q 80 101 117 91", 0.22, 0.8),
      base("M 55 212 C 62 219 98 219 105 212 L 104 218 Q 80 227 56 218 Z"),
      glint("M 59 219 Q 80 224 101 219", 0.7, 1.2),
      glint("M 46 46 C 54 42 106 42 114 46", 0.75, 0.85),
    ],
  },
  shaker_pint: {
    id: "shaker_pint",
    token: "vessel/shaker-pint",
    bodyPath:
      "M 40 47 C 40 43.5 58 41.5 80 41.5 C 102 41.5 120 43.5 120 47 L 108 216 C 107.5 223 94 227 80 227 C 66 227 52.5 223 52 216 Z",
    clipPath:
      "M 44 47 C 44 45.5 60 44.5 80 44.5 C 100 44.5 116 45.5 116 47 L 103.5 214 Q 103 221 80 221 Q 57 221 56.5 214 Z",
    rimPath: rim(40, 120, 47, 5.5),
    viewBox: "0 40 160 190",
    topY: 44.5,
    bottomY: 221,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 62 57 Q 70 55 77 57 L 77 212 Q 71 219 65 215 Z M 96 57 H 108 L 99 215 Q 93 219 89 215 Z",
        0.4,
      ),
      shine("M 46 57 Q 50 55 54 57 L 62 201 Q 60 212 57 210 Z"),
      glint("M 47 60 L 51 117 M 52 129 L 53 149", 0.65, 1.25),
      glint("M 114 58 L 103 209", 0.35, 1.4),
      base("M 55 211 Q 80 225 105 211 L 104 218 Q 102 224 80 224 Q 58 224 56 218 Z"),
      glint("M 60 221 Q 80 226 100 221", 0.7, 1.2),
      glint("M 42 46 C 52 42 108 42 118 46", 0.75, 0.9),
    ],
  },
  pilsner_flute: {
    id: "pilsner_flute",
    token: "vessel/pilsner-flute",
    bodyPath:
      "M 41 32 C 41 28.5 58 26.5 80 26.5 C 102 26.5 119 28.5 119 32 C 113 84 97 151 94 201 L 96 215 Q 104 225 80 226 Q 56 225 64 215 L 66 201 C 63 151 47 84 41 32 Z",
    clipPath:
      "M 45 32 C 45 30.5 61 29.5 80 29.5 C 99 29.5 115 30.5 115 32 C 109 85 94 152 90.5 201 L 92 212 Q 95 218.5 80 218.5 Q 65 218.5 68 212 L 69.5 201 C 66 152 51 85 45 32 Z",
    rimPath: rim(41, 119, 32, 5.5),
    viewBox: "0 25 160 205",
    topY: 29.5,
    bottomY: 218.5,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 58 43 Q 66 40 72 43 L 77 207 Q 76 214 72 211 C 71 157 62 96 58 43 Z M 96 43 H 107 C 101 91 89 167 89 210 Q 85 214 83 210 Z",
        0.6,
      ),
      shine("M 47 42 Q 51 40 55 42 C 57 97 67 140 70 176 C 62 153 51 88 47 42 Z"),
      glint("M 48 46 C 50 75 57 106 61 126", 0.62, 1.3),
      glint("M 113 44 C 107 89 95 157 92 196", 0.37, 1.15),
      base("M 68 210 Q 80 222 92 210 L 95 218 Q 95 223 80 223 Q 65 223 65 218 Z"),
      glint("M 69 220 Q 80 225 91 220", 0.72, 1.2),
      glint("M 43 31 C 54 27 106 27 117 31", 0.75, 0.85),
    ],
  },
  stange: {
    id: "stange",
    token: "vessel/stange",
    bodyPath:
      "M 52 42 C 52 38.5 64 36.5 80 36.5 C 96 36.5 108 38.5 108 42 L 107 219 C 107 225 94 229 80 229 C 66 229 53 225 53 219 Z",
    clipPath:
      "M 55 42 C 55 40.5 66 39.5 80 39.5 C 94 39.5 105 40.5 105 42 L 103.5 217 Q 103.5 222.5 80 222.5 Q 56.5 222.5 56.5 217 Z",
    rimPath: rim(52, 108, 42, 5.5),
    viewBox: "0 35 160 200",
    topY: 39.5,
    bottomY: 222.5,
    fillX: 52,
    fillWidth: 56,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 67 52 Q 72 50 76 52 L 77 215 Q 74 221 69 217 Z M 88 52 H 98 V 216 Q 94 221 89 217 Z",
        0.42,
      ),
      shine("M 57 51 Q 61 49 64 51 L 63 204 Q 61 214 58 210 Z"),
      glint("M 58 55 V 118 M 58 129 V 149", 0.65, 1.2),
      glint("M 102 53 L 101.5 212", 0.36, 1.6),
      base("M 55 214 Q 80 227 105 214 V 220 Q 102 227 80 227 Q 58 227 55 220 Z"),
      glint("M 60 223 Q 80 230 100 223", 0.72, 1.1),
      glint("M 54 41 C 61 37 99 37 106 41", 0.75, 0.85),
    ],
  },
  goblet: {
    id: "goblet",
    token: "vessel/goblet",
    bodyPath:
      "M 41 49 C 41 44.5 58 41.5 80 41.5 C 102 41.5 119 44.5 119 49 C 124 78 122 110 109 133 C 101 148 90 162 80 167 C 70 162 59 148 51 133 C 38 110 36 78 41 49 Z",
    clipPath:
      "M 45 49 C 45 47 61 45.5 80 45.5 C 99 45.5 115 47 115 49 C 120 79 117 109 106 130 C 96 147 88 157 80 161.5 C 72 157 64 147 54 130 C 43 109 40 79 45 49 Z",
    rimPath: rim(41, 119, 49, 7.5),
    viewBox: "0 40 160 200",
    topY: 45.5,
    bottomY: 161.5,
    fillX: 35,
    fillWidth: 90,
    detailPaths: pedestal(167, 233, 37, 4.5),
    frontPaths: [
      facet(
        "M 56 60 Q 63 57 69 60 C 64 105 66 134 77 155 C 58 140 49 93 56 60 Z M 95 60 Q 102 57 109 60 C 113 102 103 130 88 150 C 95 122 99 94 95 60 Z",
        0.7,
      ),
      shine("M 46 61 Q 50 58 54 60 C 49 90 50 113 62 135 C 45 125 40 90 46 61 Z"),
      glint("M 47 66 C 44 87 47 109 52 120", 0.65, 1.2),
      glint("M 116 64 C 121 101 109 128 99 142", 0.38, 1.5),
      base("M 65 151 Q 80 166 95 151 Q 88 163 80 165 Q 72 163 65 151 Z"),
      glint("M 69 158 Q 80 167 91 158", 0.62, 0.9),
      glint("M 44 47 C 54 42 106 42 116 47", 0.78, 1),
    ],
  },
  teku: {
    id: "teku",
    token: "vessel/teku",
    bodyPath:
      "M 52 47 C 52 43.5 64 41.5 80 41.5 C 96 41.5 108 43.5 108 47 L 103 70 L 122 117 L 88 169 Q 80 177 72 169 L 38 117 L 57 70 Z",
    clipPath:
      "M 56 47 C 56 45.5 66 44.5 80 44.5 C 94 44.5 104 45.5 104 47 L 99.5 70 L 117.5 116.5 L 85 165 Q 80 170 75 165 L 42.5 116.5 L 60.5 70 Z",
    rimPath: rim(52, 108, 47, 5.5),
    viewBox: "0 40 160 200",
    topY: 44.5,
    bottomY: 167.5,
    fillX: 38,
    fillWidth: 84,
    detailPaths: pedestal(173, 233, 36),
    frontPaths: [
      facet("M 66 78 L 58 116 L 77 163 L 45 116 Z M 95 78 L 115 116 L 85 162 L 99 116 Z", 0.82),
      shine("M 56 55 L 61 55 L 64 70 L 48 115 L 68 148 L 42 117 L 60 70 Z"),
      glint("M 59 57 L 62 70 L 45 115 L 62 141", 0.63, 1.15),
      glint("M 105 83 L 119 117 L 94 154", 0.42, 1.25),
      glint("M 45 117 Q 80 129 115 117", 0.28, 0.8),
      base("M 65 157 L 76 168 Q 80 172 84 168 L 95 157 L 86 169 Q 80 176 74 169 Z"),
      glint("M 54 46 C 60 42 100 42 106 46", 0.75, 0.85),
    ],
  },
  thistle: {
    id: "thistle",
    token: "vessel/thistle",
    bodyPath:
      "M 42 48 C 42 44 59 41.5 80 41.5 C 101 41.5 118 44 118 48 C 110 62 104 70 104 81 C 115 101 116 124 105 143 C 99 153 89 165 80 170 C 71 165 61 153 55 143 C 44 124 45 101 56 81 C 56 70 50 62 42 48 Z",
    clipPath:
      "M 46 48 C 46 46 61 45 80 45 C 99 45 114 46 114 48 C 106 63 100 72 100 82 C 112 104 111 123 102 141 C 95 153 87 161 80 164.5 C 73 161 65 153 58 141 C 49 123 48 104 60 82 C 60 72 54 63 46 48 Z",
    rimPath: rim(42, 118, 48, 6.5),
    viewBox: "0 40 160 200",
    topY: 45,
    bottomY: 164.5,
    fillX: 40,
    fillWidth: 80,
    detailPaths: pedestal(170, 233, 33, 4),
    frontPaths: [
      facet(
        "M 59 91 L 67 90 C 60 110 61 130 76 159 C 60 148 48 125 59 91 Z M 76 91 H 84 L 85 157 Q 80 166 75 157 Z M 93 90 L 101 91 C 112 125 100 148 84 159 C 99 130 100 110 93 90 Z",
        0.85,
      ),
      shine(
        "M 48 57 Q 52 54 57 56 C 65 68 66 76 63 85 C 53 107 50 123 60 140 C 45 128 47 107 58 83 C 61 75 55 65 48 57 Z",
      ),
      glint("M 50 58 Q 65 76 60 85 C 53 99 51 110 52 122", 0.63, 1.2),
      glint("M 105 92 C 116 118 106 140 95 151", 0.36, 1.2),
      glint(
        "M 62 96 C 56 119 63 141 73 153 M 78 95 L 78 151 M 99 97 C 106 119 98 141 90 153",
        0.26,
        0.8,
      ),
      base("M 64 153 Q 80 170 96 153 Q 87 165 80 168 Q 73 165 64 153 Z"),
      glint("M 45 47 C 53 42 107 42 115 47", 0.76, 0.9),
    ],
  },
  ipa_glass: {
    id: "ipa_glass",
    token: "vessel/ipa-glass",
    bodyPath:
      "M 46 38 C 46 34.5 61 31.5 80 31.5 C 99 31.5 114 34.5 114 38 C 124 70 122 101 107 126 Q 99 139 99 151 L 103 158 L 100 167 L 103 176 L 100 185 L 103 194 L 100 203 L 102 214 Q 103 226 80 226 Q 57 226 58 214 L 60 203 L 57 194 L 60 185 L 57 176 L 60 167 L 57 158 L 61 151 Q 61 139 53 126 C 38 101 36 70 46 38 Z",
    clipPath:
      "M 50 38 C 50 36 63 35 80 35 C 97 35 110 36 110 38 C 120 71 117 101 104 124 Q 94 139 96 153 L 98.5 158 L 96.5 167 L 99 176 L 96.5 185 L 99 194 L 96.5 203 L 98 213 Q 99 219.5 80 219.5 Q 61 219.5 62 213 L 63.5 203 L 61 194 L 63.5 185 L 61 176 L 63.5 167 L 61.5 158 L 64 153 Q 66 139 56 124 C 43 101 40 71 50 38 Z",
    rimPath: rim(46, 114, 38, 6.5),
    viewBox: "0 30 160 205",
    topY: 35,
    bottomY: 219.5,
    fillX: 35,
    fillWidth: 90,
    detailPaths: [],
    frontPaths: [
      facet(
        "M 62 49 Q 68 47 73 49 C 67 91 70 119 75 142 V 209 Q 72 217 69 211 C 73 160 55 121 54 91 Q 53 68 56 51 Z M 96 49 Q 102 47 106 50 C 112 91 101 117 88 141 L 87 211 Q 94 217 93 208 C 83 167 111 108 106 69 Z",
        0.6,
      ),
      shine("M 50 50 Q 54 47 58 49 C 48 80 50 110 63 131 C 44 118 40 79 50 50 Z"),
      glint("M 51 55 C 45 74 46 91 50 106", 0.67, 1.25),
      glint("M 114 53 C 123 83 112 113 102 131", 0.36, 1.4),
      base(
        "M 59 155 Q 80 162 101 155 L 102 160 Q 80 168 58 160 Z M 60 173 Q 80 180 100 173 L 102 178 Q 80 186 58 178 Z M 60 191 Q 80 198 100 191 L 102 196 Q 80 204 58 196 Z",
      ),
      glint(
        "M 60 158 Q 80 164 100 158 M 61 176 Q 80 182 99 176 M 61 194 Q 80 200 99 194",
        0.63,
        1.1,
      ),
      detail(
        "M 61 166 Q 80 173 99 166 M 61 184 Q 80 191 99 184 M 61 202 Q 80 209 99 202",
        "glass-detail",
        "none",
        "#698895",
        0.8,
        0.45,
      ),
      base("M 61 211 Q 80 223 99 211 L 100 217 Q 99 224 80 224 Q 61 224 60 217 Z"),
      glint("M 65 220 Q 80 226 95 220", 0.7, 1.15),
      glint("M 49 36 C 56 32 104 32 111 36", 0.76, 0.9),
    ],
  },
  tasting_glass: {
    id: "tasting_glass",
    token: "vessel/tasting-glass",
    bodyPath:
      "M 55 58 C 55 54.5 66 51.5 80 51.5 C 94 51.5 105 54.5 105 58 C 115 83 119 107 112 127 C 107 142 93 158 80 164 C 67 158 53 142 48 127 C 41 107 45 83 55 58 Z",
    clipPath:
      "M 59 58 C 59 56 68 55 80 55 C 92 55 101 56 101 58 C 111 84 115 106 108 125 C 102 141 91 153 80 158.5 C 69 153 58 141 52 125 C 45 106 49 84 59 58 Z",
    rimPath: rim(55, 105, 58, 6.5),
    viewBox: "0 45 160 195",
    topY: 55,
    bottomY: 158.5,
    fillX: 40,
    fillWidth: 80,
    detailPaths: pedestal(164, 233, 32, 3),
    frontPaths: [
      facet(
        "M 66 70 Q 70 67 75 69 C 66 102 66 130 77 152 C 58 135 55 103 66 70 Z M 95 71 C 111 103 107 126 91 145 C 98 119 96 94 95 71 Z",
        0.66,
      ),
      shine("M 57 70 Q 61 67 64 68 C 50 97 48 116 59 133 C 42 126 44 97 57 70 Z"),
      glint("M 58 73 C 49 93 48 106 49 116", 0.66, 1.2),
      glint("M 107 77 C 117 105 109 129 99 141", 0.36, 1.3),
      base("M 64 146 Q 80 163 96 146 Q 88 159 80 162 Q 72 159 64 146 Z"),
      glint("M 69 155 Q 80 164 91 155", 0.6, 0.85),
      glint("M 57 56 C 64 52 96 52 103 56", 0.74, 0.85),
    ],
  },
  stemmed_lager: {
    id: "stemmed_lager",
    token: "vessel/stemmed-lager",
    bodyPath:
      "M 49 42 C 49 38.5 63 36.5 80 36.5 C 97 36.5 111 38.5 111 42 L 107 121 C 105 147 95 170 80 177 C 65 170 55 147 53 121 Z",
    clipPath:
      "M 53 42 C 53 40.5 65 39.5 80 39.5 C 95 39.5 107 40.5 107 42 L 103.5 121 C 102 145 92 165 80 171.5 C 68 165 58 145 56.5 121 Z",
    rimPath: rim(49, 111, 42, 5.5),
    viewBox: "0 35 160 205",
    topY: 39.5,
    bottomY: 171.5,
    fillX: 45,
    fillWidth: 70,
    detailPaths: pedestal(177, 233, 35, 3.5),
    frontPaths: [
      facet(
        "M 65 53 Q 71 50 76 53 L 77 162 C 64 148 62 124 65 53 Z M 94 53 H 102 L 99 122 Q 96 149 86 163 C 92 135 94 95 94 53 Z",
        0.62,
      ),
      shine("M 55 53 Q 59 50 62 52 L 62 122 Q 62 143 72 159 C 60 153 57 139 56 124 Z"),
      glint("M 56 57 L 57.5 111 M 58 121 Q 58 134 62 143", 0.65, 1.2),
      glint("M 106 55 L 102.5 122 Q 99 151 90 162", 0.36, 1.3),
      base("M 66 161 Q 80 177 94 161 Q 89 173 80 175 Q 71 173 66 161 Z"),
      glint("M 70 169 Q 80 177 90 169", 0.6, 0.85),
      glint("M 51 41 C 58 37 102 37 109 41", 0.75, 0.85),
    ],
  },
};

for (const id of VESSEL_IDS) {
  Object.freeze(GEOMETRY[id].detailPaths);
  Object.freeze(GEOMETRY[id].frontPaths);
  Object.freeze(GEOMETRY[id]);
}
Object.freeze(GEOMETRY);

export const DEFAULT_VESSEL_ID: VesselId = "pint_glass";

function record(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return result === "" ? null : result;
}

const VESSEL_ALIASES: Readonly<Record<string, VesselId>> = {
  pint: "pint_glass",
  glass: "pint_glass",
  tulip: "tulip_glass",
  wheat: "wheat_glass",
  stout: "stout_glass",
  lager: "stemmed_lager",
  pilsner: "pilsner_flute",
  pils: "pilsner_flute",
  ipa: "ipa_glass",
  tasting: "tasting_glass",
  goblet_glass: "goblet",
};

export function isVesselId(value: unknown): value is VesselId {
  const candidate = normalized(value);
  return candidate !== null && (VESSEL_IDS as readonly string[]).includes(candidate);
}

function explicitVessel(value: unknown): VesselId | null {
  const candidate = normalized(value);
  if (candidate === null) return null;
  if (isVesselId(candidate)) return candidate;
  return VESSEL_ALIASES[candidate] ?? null;
}

function styleValue(input: unknown): string | null {
  const object = record(input);
  if (object === null) return null;
  for (const key of ["style", "beverageStyle", "styleName", "beerStyle", "type", "beverageType"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return null;
}

function styleVessel(style: string | null): VesselId {
  if (style === null) return DEFAULT_VESSEL_ID;
  // Keep the reviewed v1 ordering: specific style families win before the
  // broad ale/lager rules at the end of the list.
  if (/wheat|wit|weiss|weizen/.test(style)) return "wheat_glass";
  if (/pilsner/.test(style)) return "pilsner_flute";
  if (/kolsch|kölsch|altbier/.test(style)) return "stange";
  if (/belgian|abbey|saison|tripel|triple/.test(style)) return "goblet";
  if (/ipa|pale ale/.test(style)) return "ipa_glass";
  if (/sour|lambic|wild/.test(style)) return "teku";
  if (/stout|porter/.test(style)) return "stout_glass";
  if (/wee heavy|scotch/.test(style)) return "thistle";
  if (/barleywine|strong ale/.test(style)) return "snifter";
  if (/english bitter|\bmild\b|brown|esb/.test(style)) return "nonic_pint";
  if (/american amber|\bale\b/.test(style)) return "shaker_pint";
  if (/lager|helles|marzen|märzen|bock/.test(style)) return "stemmed_lager";
  return DEFAULT_VESSEL_ID;
}

function candidateExplicit(input: unknown): VesselId | null {
  const object = record(input);
  if (object === null) return explicitVessel(input);
  for (const key of ["fillGlass", "fill_glass", "fillGlassId", "vessel", "vesselId", "glass"]) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const value = explicitVessel(object[key]);
    if (value !== null) return value;
  }
  return null;
}

export function getVesselDescriptor(value: unknown): VesselGeometryDescriptor {
  const id = explicitVessel(value) ?? DEFAULT_VESSEL_ID;
  return GEOMETRY[id];
}

export const vesselGeometry = getVesselDescriptor;
export const getSafeVesselGeometry = getVesselDescriptor;

/** Resolve explicit fill-glass selection, then style evidence, then pint. */
export function resolveVessel(input: unknown): VesselResolution {
  const explicit = candidateExplicit(input);
  if (explicit !== null) return { id: explicit, geometry: GEOMETRY[explicit], source: "explicit" };
  const style = styleValue(input);
  const id = styleVessel(style);
  return {
    id,
    geometry: GEOMETRY[id],
    source: style === null || id === DEFAULT_VESSEL_ID ? "fallback" : "style",
  };
}

export function resolveVesselId(input: unknown): VesselId {
  return resolveVessel(input).id;
}

export const chooseVessel = resolveVesselId;
export const resolveFillGlass = resolveVesselId;
export const suggestVessel = resolveVesselId;
export const FILL_GLASS_IDS = VESSEL_IDS;

export const SRM_COLOR_PALETTE: readonly { readonly srm: number; readonly color: string }[] = [
  { srm: 0, color: "#EAF6FF" },
  { srm: 1, color: "#F8F753" },
  { srm: 2, color: "#F6F513" },
  { srm: 3, color: "#ECE61A" },
  { srm: 4, color: "#D5BC00" },
  { srm: 5, color: "#BF9200" },
  { srm: 6, color: "#BF8100" },
  { srm: 7, color: "#BC6800" },
  { srm: 8, color: "#B55300" },
  { srm: 9, color: "#B34700" },
  { srm: 10, color: "#A73D00" },
  { srm: 11, color: "#9C3200" },
  { srm: 12, color: "#962D00" },
  { srm: 13, color: "#8C2400" },
  { srm: 14, color: "#801C00" },
  { srm: 15, color: "#781900" },
  { srm: 16, color: "#701600" },
  { srm: 17, color: "#681300" },
  { srm: 18, color: "#601100" },
  { srm: 19, color: "#580E00" },
  { srm: 20, color: "#530C00" },
  { srm: 21, color: "#4E0B00" },
  { srm: 22, color: "#480A00" },
  { srm: 23, color: "#420900" },
  { srm: 24, color: "#3C0800" },
  { srm: 25, color: "#380600" },
  { srm: 26, color: "#340500" },
  { srm: 27, color: "#300400" },
  { srm: 28, color: "#2C0300" },
  { srm: 29, color: "#2A0300" },
  { srm: 30, color: "#280200" },
  { srm: 31, color: "#250200" },
  { srm: 32, color: "#220200" },
  { srm: 33, color: "#200100" },
  { srm: 34, color: "#1E0100" },
  { srm: 35, color: "#1D0100" },
  { srm: 36, color: "#1B0100" },
  { srm: 37, color: "#190100" },
  { srm: 38, color: "#170100" },
  { srm: 39, color: "#150100" },
  { srm: 40, color: "#130100" },
  { srm: 45, color: "#0B0100" },
  { srm: 50, color: "#080100" },
] as const;

export const SAFE_DISPLAY_COLOR = "#D97706";

export function normalizeDisplayColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : null;
}

export function displayColorForSrm(value: unknown): string | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) return null;
  const srm = Math.min(50, Math.max(0, Math.round(parsed)));
  let closest = SRM_COLOR_PALETTE[0];
  if (closest === undefined) return null;
  let distance = Math.abs(srm - closest.srm);
  for (const candidate of SRM_COLOR_PALETTE.slice(1)) {
    const nextDistance = Math.abs(srm - candidate.srm);
    if (nextDistance < distance) {
      closest = candidate;
      distance = nextDistance;
    }
  }
  return closest.color;
}

/** Valid explicit #RRGGBB wins; otherwise use a finite SRM palette/fallback. */
export function resolveDisplayColor(input: unknown, srmValue?: unknown): string {
  const object = record(input);
  const explicit = normalizeDisplayColor(
    object === null
      ? input
      : (object["displayColor"] ?? object["display_color"] ?? object["color"]),
  );
  if (explicit !== null) return explicit;
  const srm = object === null ? srmValue : (object["srm"] ?? object["colorSrm"] ?? srmValue);
  return displayColorForSrm(srm) ?? SAFE_DISPLAY_COLOR;
}

export const safeDisplayColor = resolveDisplayColor;
export const resolveColor = resolveDisplayColor;

export { VESSEL_IDS };
export type { VesselGeometryDescriptor, VesselId, VesselResolution };
