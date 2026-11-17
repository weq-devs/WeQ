type AvatarPalette = {
  bg: string;
  ring: string;
  body: string;
  face: string;
  eye: string;
  accent: string;
  shadow: string;
};

export const PALETTES: AvatarPalette[] = [
  {
    bg: '#eef6ff',
    ring: '#d8ebff',
    body: '#dce8f3',
    face: '#f8fbff',
    eye: '#8aa0b2',
    accent: '#1298f0',
    shadow: '#d4e2ee',
  },
  {
    bg: '#effaf4',
    ring: '#d8f0e2',
    body: '#dcebe3',
    face: '#fbfffd',
    eye: '#83a08d',
    accent: '#21c978',
    shadow: '#d3e4da',
  },
  {
    bg: '#fff7e8',
    ring: '#f4e3bf',
    body: '#ece0ca',
    face: '#fffdf8',
    eye: '#a19379',
    accent: '#ffb22d',
    shadow: '#e8d9bb',
  },
  {
    bg: '#fff0f3',
    ring: '#f2d7df',
    body: '#eadce2',
    face: '#fff9fb',
    eye: '#a18691',
    accent: '#ff6b8d',
    shadow: '#e5d1da',
  },
  {
    bg: '#f3f1ff',
    ring: '#dedafd',
    body: '#e0ddf0',
    face: '#fbfaff',
    eye: '#8c88aa',
    accent: '#7c6cf2',
    shadow: '#d8d3ee',
  },
  {
    bg: '#f1fbfb',
    ring: '#d8eeee',
    body: '#dceaea',
    face: '#fbffff',
    eye: '#7f9d9d',
    accent: '#1ab3bd',
    shadow: '#d3e5e5',
  },
];

export function pickDefaultAvatarIndex(seed: string) {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash % PALETTES.length;
}
