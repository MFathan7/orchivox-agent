// Sampled from the emblem in assets/Orchivox Agent.jpeg; no image decoding at startup.
export const ORBIT_EMBLEM = [
  ["     ⢀⡤⠴⠒⠚⠉    ⢀      ", "     CCCCCC    M      "],
  ["   ⣠⢞⠝⣢⣴⢖⣡⠶⠛⣩⣭⣭⣐⠈⠢⣤⡀  ", "   CCCCCCCCCCCCCMMMM  "],
  [" ⢀⡾⡽⣡⣾⡟⣱⠟⣱⣶⣶⣶⣦⣭⣿⣷⣎⠩⠑⡀ ", " CCCCCCCCVVVVVCCCMMMM "],
  [" ⡞⡜⣰⣿⡟⣸⠏⠈⡠⠤⠤⢄⠉⠻⣿⣿⣿⣧⠁  ", " CCCCCCCVCCCCCCCCMMM  "],
  ["⢸⢱⢁⣿⣿⡇⣿⢠⢀⣶⣿⣿⣶⡀⠄⣌⢿⣿⣿⡄  ", "CCCCCCCCCCCCCCCMCCCM  "],
  ["⠘⢘⢸⡿⡞⣇⢻ ⠈⣻⣿⣿⣿⡇ ⢸⠸⣿⣿⡇⡆⡆", "CCCCCCV CCCCCC MCCCCMM"],
  ["   ⣧⡱⡜⣦⡀ ⠉⠛⠓⢋ ⠁⣾⢰⣿⣿⢁⢃⠇", "   VCCVV VVVC CMCCCCMM"],
  [" ⠠ ⠘⢿⢞⣾⣿⣦⣄⣀⣀⣠⠔⣼⢇⣾⣻⢃⢌⡞ ", " V VVVCVVVVVVVCCCCCCM "],
  ["  ⠑⣤⡼⠻⢾⣶⣭⣍⠙⢛⣡⠞⣡⣮⠟⡡⣪⠞  ", "  VVVVVCCCCCCCCCCCCM  "],
  ["   ⠙⠓⠄⡒⠶⠶⠶⠚⠋⠑⠚⠉⢀⣨⠞⠁   ", "   VVVVVVVCCVCCCCCC   "],
  ["           ⠤⠴⠒⠚⠉      ", "           CCCCC      "],
] as const;

export const SMALL_ORBIT_EMBLEM = [
  [" ⣠⢔⣨⡩⠤⣄⡀⣄ ", " CCCCCCCM "],
  ["⢰⣻⣿⡟⢋⣙⠻⣿⡆ ", "CCCCVCCCM "],
  ["⠉⢿⣿⠂⣿⣿ ⣿⣿⠠", "CCCCCC CCM"],
  [" ⢘⣿⣷⠤⢤⣼⡿⣣⠇", " VVCCCCCCM"],
  [" ⠈ ⠙⠋⠉⠩⠒⠁ ", " V VCCCCC "],
] as const;

export const COMPACT_LOGO_TEXT = "⠔◉⠢";

// [row, column] coordinates run clockwise outside the small emblem.
const INSTALLATION_ORBIT = [
  [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9],
  [1, 11], [2, 12], [3, 13], [4, 12], [5, 11],
  [6, 9], [6, 8], [6, 7], [6, 6], [6, 5], [6, 4],
  [5, 2], [4, 1], [3, 0], [2, 1], [1, 2],
] as const;

const ORBIT_TRAIL_GLYPHS = "⠿⠶⠤⠆⠂⠁";
const ORBIT_TRAIL_TONES = "MMCCVV";
export const INSTALLATION_ORBIT_FRAMES = INSTALLATION_ORBIT.length;
export const INSTALLATION_LOGO_HEIGHT = SMALL_ORBIT_EMBLEM.length + 2;
export const INSTALLATION_LOGO_WIDTH = SMALL_ORBIT_EMBLEM[0][0].length + 4;

export function installationLogo(frame?: number): ReadonlyArray<readonly [string, string]> {
  const blank = " ".repeat(INSTALLATION_LOGO_WIDTH);
  const rows: [string, string][] = [
    [blank, blank],
    ...SMALL_ORBIT_EMBLEM.map(([glyphs, tones]): [string, string] => [`  ${glyphs}  `, `  ${tones}  `]),
    [blank, blank],
  ];
  if (frame === undefined) return rows;

  for (let offset = 0; offset < ORBIT_TRAIL_GLYPHS.length; offset++) {
    const [row, column] = INSTALLATION_ORBIT[(frame + INSTALLATION_ORBIT_FRAMES - offset) % INSTALLATION_ORBIT_FRAMES];
    const [glyphs, tones] = rows[row];
    rows[row] = [
      glyphs.slice(0, column) + ORBIT_TRAIL_GLYPHS[offset] + glyphs.slice(column + 1),
      tones.slice(0, column) + ORBIT_TRAIL_TONES[offset] + tones.slice(column + 1),
    ];
  }
  return rows;
}
