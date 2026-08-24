// ---------------------------------------------------------------------------
// Tuning constants, track definitions, palettes.
// World units: 1u ≈ 0.5 m. Karts are ~4.6u long, the road is 28u wide.
// ---------------------------------------------------------------------------

export const CFG = {
  worldScale: 800,          // spread of the control-point layout
  roadWidth: 28,
  kerbWidth: 3.4,
  roadLift: 0.12,           // road ribbon floats this far above the terrain splat
  samplesPerSeg: 40,        // spline samples per control segment
  wpStride: 6,              // waypoints = every Nth sample

  topSpeed: 70,
  accel: 80,
  brake: 135,
  revSpeed: 20,
  steerPower: 3.3,
  grassFactor: 0.55,
  driftT1: 0.85,            // seconds of drift for the blue mini-turbo
  driftT2: 1.75,            // … and the orange one
  kartRadius: 2.3,

  camDist: 13.4,
  camHeight: 6.4,
  camLookAhead: 9.5,
  fovBase: 66,

  gridE: 620,               // heightfield half-extent
  gridN: 256,               // heightfield resolution
};

// Weight drives the class tradeoff: heavies have higher top speed and shove
// lighter karts around; lightweights accelerate and corner better.
export const CHARACTERS = [
  {
    name: 'Dash', head: 'human', weight: 1.0, voice: 1.0,
    tag: 'All-rounder',
    palette: { body: 0xe8443c, accent: 0xffd34d, suit: 0xb8322c, helmet: 0xf4f4f4, dark: 0x2c2c34, skin: 0xf4f4f4 },
  },
  {
    name: 'Torque', head: 'robot', weight: 1.18, voice: 0.6,
    tag: 'Heavy metal',
    palette: { body: 0x5a6a7a, accent: 0x18e0ff, suit: 0x3a4654, helmet: 0x8b98a8, dark: 0x232a33, skin: 0x8b98a8 },
  },
  {
    name: 'Whiskers', head: 'cat', weight: 0.86, voice: 1.5,
    tag: 'Featherweight',
    palette: { body: 0xf2843d, accent: 0xffffff, suit: 0xc96a2b, helmet: 0xf2a35d, dark: 0x40312a, skin: 0xf2a35d },
  },
  {
    name: 'Bones', head: 'skull', weight: 0.95, voice: 0.85,
    tag: 'Rattling on',
    palette: { body: 0x2b2b33, accent: 0x9df24d, suit: 0x1d1d24, helmet: 0xf2f2ea, dark: 0x17171c, skin: 0xf2f2ea },
  },
  {
    name: 'Nana Nitro', head: 'granny', weight: 0.9, voice: 1.25,
    tag: 'Deceptively fast',
    palette: { body: 0xa45ce8, accent: 0xffd9f7, suit: 0x8244c2, helmet: 0xd8d8dc, dark: 0x2f2740, skin: 0xf0c8a8 },
  },
  {
    name: 'Zorb', head: 'alien', weight: 1.0, voice: 1.8,
    tag: 'Out of this world',
    palette: { body: 0x46c46a, accent: 0xd5ecff, suit: 0x35a052, helmet: 0x7de08a, dark: 0x27382c, skin: 0x7de08a },
  },
  {
    name: 'Quackers', head: 'duck', weight: 0.84, voice: 1.6,
    tag: 'Lightning quick',
    palette: { body: 0xf2c33d, accent: 0x3d8ef2, suit: 0xc99a2b, helmet: 0xf2d23d, dark: 0x3d3527, skin: 0xf2d23d },
  },
  {
    name: 'Big Ceez', head: 'bear', weight: 1.2, voice: 0.5,
    tag: 'The bulldozer',
    palette: { body: 0x8a5a2b, accent: 0xf2c33d, suit: 0x6b4a2b, helmet: 0xa8763a, dark: 0x3d2f1f, skin: 0xa8763a },
  },
];

export function charStats(c) {
  return {
    top: 0.94 + c.weight * 0.075,
    accel: 1.2 - c.weight * 0.24,
    steer: 1.16 - c.weight * 0.16,
    mass: c.weight,
  };
}

export const MODES = ['Single Race', 'Grand Prix', 'Time Trial'];
export const GP_POINTS = [10, 8, 6, 4, 2, 1];

export const DIFFICULTIES = [
  { name: 'Cruise', skill: 0.80, band: 0.05 },
  { name: 'Rival', skill: 0.92, band: 0.09 },
  { name: 'Blistering', skill: 1.00, band: 0.14 },
];

export const TRACK_DEFS = [
  {
    name: 'Sunset Circuit',
    seed: 1337,
    laps: 3,
    elevAmp: 13,
    deco: 'pine',
    points: [
      [0.50, 0.12], [0.71, 0.16], [0.86, 0.30], [0.84, 0.48], [0.69, 0.57],
      [0.62, 0.71], [0.70, 0.85], [0.50, 0.91], [0.31, 0.86], [0.20, 0.71],
      [0.28, 0.55], [0.17, 0.41], [0.29, 0.20],
    ],
    theme: {
      skyTop: '#241650', skyMid: '#a8437a', horizon: '#f0a06a',
      fog: '#e0946e', fogNear: 260, fogFar: 1400,
      sun: '#ffd07a', sunDir: [0.85, 0.22, 0.4], sunScale: 320,
      hemiSky: '#ffd2b0', hemiGround: '#5a4a6a', hemiInt: 1.1,
      dirColor: '#ffca9a', dirInt: 2.2,
      grassA: '#4a8a3d', grassB: '#33652a',
      road: '#4c4c56', mountain: '#40305e',
      stars: false, glowEdges: false,
    },
  },
  {
    name: 'Coconut Bay',
    seed: 90210,
    laps: 3,
    elevAmp: 8,
    deco: 'palm',
    points: [
      [0.50, 0.15], [0.68, 0.13], [0.82, 0.24], [0.79, 0.39], [0.63, 0.45],
      [0.60, 0.58], [0.78, 0.62], [0.87, 0.76], [0.72, 0.88], [0.52, 0.83],
      [0.36, 0.89], [0.18, 0.80], [0.15, 0.60], [0.29, 0.50], [0.22, 0.34],
      [0.33, 0.18],
    ],
    theme: {
      skyTop: '#1565b8', skyMid: '#5cb4e8', horizon: '#cfeeff',
      fog: '#c4e6f4', fogNear: 300, fogFar: 1500,
      sun: '#fff6c8', sunDir: [0.3, 0.75, -0.5], sunScale: 240,
      hemiSky: '#eaf6ff', hemiGround: '#b09a70', hemiInt: 1.25,
      dirColor: '#fff4d8', dirInt: 2.6,
      grassA: '#dcc78e', grassB: '#c2a86c',
      road: '#5c5764', mountain: '#2f8ba0',
      stars: false, glowEdges: false,
    },
  },
  {
    name: 'Volcano Rush',
    seed: 6660,
    laps: 3,
    elevAmp: 20,
    deco: 'spire',
    hazard: 'lava',
    points: [
      [0.50, 0.10], [0.70, 0.13], [0.83, 0.25], [0.78, 0.40], [0.62, 0.44],
      [0.55, 0.56], [0.68, 0.64], [0.83, 0.72], [0.75, 0.87], [0.55, 0.90],
      [0.42, 0.80], [0.30, 0.88], [0.16, 0.78], [0.14, 0.60], [0.26, 0.48],
      [0.18, 0.33], [0.30, 0.16],
    ],
    theme: {
      skyTop: '#160404', skyMid: '#571408', horizon: '#c2431a',
      fog: '#38110a', fogNear: 170, fogFar: 1050,
      sun: '#ff7a30', sunDir: [0.5, 0.3, -0.6], sunScale: 310,
      hemiSky: '#ff9a60', hemiGround: '#2a0f08', hemiInt: 1.0,
      dirColor: '#ffb080', dirInt: 1.7,
      grassA: '#4a3630', grassB: '#31221d',
      road: '#3a3038', mountain: '#240f0b',
      stars: false, glowEdges: true, glowColors: [0xff6a20, 0xff3a10],
    },
  },
  {
    name: 'Frostbite Falls',
    seed: 24601,
    laps: 3,
    elevAmp: 16,
    deco: 'snowpine',
    hazard: 'ice',
    points: [
      [0.50, 0.12], [0.72, 0.15], [0.86, 0.28], [0.83, 0.46], [0.70, 0.55],
      [0.72, 0.70], [0.60, 0.84], [0.42, 0.88], [0.28, 0.80], [0.30, 0.64],
      [0.20, 0.52], [0.16, 0.36], [0.28, 0.20],
    ],
    theme: {
      skyTop: '#2a68c0', skyMid: '#a0d0f0', horizon: '#eef8ff',
      fog: '#dceefb', fogNear: 230, fogFar: 1400,
      sun: '#fffce0', sunDir: [-0.4, 0.6, 0.4], sunScale: 230,
      hemiSky: '#eaf6ff', hemiGround: '#b8c8d8', hemiInt: 1.35,
      dirColor: '#fff8e8', dirInt: 2.3,
      grassA: '#e8f2f8', grassB: '#cbdeeb',
      road: '#4e5560', mountain: '#7fa8c8',
      stars: false, glowEdges: false,
    },
  },
  {
    name: 'Neon Ridge',
    seed: 5150,
    laps: 3,
    elevAmp: 17,
    deco: 'pylon',
    points: [
      [0.50, 0.10], [0.74, 0.14], [0.88, 0.31], [0.74, 0.42], [0.55, 0.38],
      [0.42, 0.48], [0.55, 0.60], [0.76, 0.63], [0.86, 0.79], [0.66, 0.90],
      [0.44, 0.86], [0.30, 0.92], [0.14, 0.78], [0.19, 0.58], [0.32, 0.50],
      [0.16, 0.36], [0.28, 0.17],
    ],
    theme: {
      skyTop: '#020208', skyMid: '#1a0f40', horizon: '#4a2168',
      fog: '#241540', fogNear: 150, fogFar: 950,
      sun: '#ff5fd2', sunDir: [-0.6, 0.3, 0.75], sunScale: 200,
      hemiSky: '#5a48a0', hemiGround: '#181834', hemiInt: 1.05,
      dirColor: '#b090ff', dirInt: 1.5,
      grassA: '#1c2140', grassB: '#131630',
      road: '#2e2e3a', mountain: '#120d28',
      stars: true, glowEdges: true,
    },
  },
];
