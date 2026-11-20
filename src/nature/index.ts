import { branch } from './branch.ts';
import { cells } from './cells.ts';
import { coral } from './coral.ts';
import { galaxy } from './galaxy.ts';
import type { Scene, Snapshot } from './model.ts';
import { sunflower } from './sunflower.ts';

export interface NatureLayout {
  name: string;
  title: string;
  blurb: string;
  run: (s: Snapshot) => Scene;
}

export const NATURE: NatureLayout[] = [
  {
    name: 'sunflower',
    title: 'Sunflower',
    blurb:
      'Phyllotaxis. Each folder is a flower head: its files are florets set one per golden angle (137.5°), small ones at the centre. Subfolders are whole heads strung on the same spiral, after the files, so a folder is a head ringed by smaller heads.',
    run: sunflower,
  },
  {
    name: 'tree',
    title: 'Tree',
    blurb:
      'Botanical branching. The root is the trunk; each folder is a branch from its parent’s tip, aimed into its own slice of the crown. Files are leaves, alternating along the branch. Branch thickness follows da Vinci’s rule: width grows with the square root of the files it carries.',
    run: branch,
  },
  {
    name: 'cells',
    title: 'Cells',
    blurb:
      'Plant tissue. A Voronoi treemap: the root cell divides into one cell per file and subfolder, and each subfolder divides again. Cell area follows file size. It fills space completely and nothing overlaps.',
    run: cells,
  },
  {
    name: 'coral',
    title: 'Coral',
    blurb:
      'Growth by accretion. Files settle one at a time, each touching a file of its own folder, and a folder’s first file settles on its parent’s. Spots far out and with few neighbours win, as in diffusion-limited aggregation, so folders grow as branches.',
    run: coral,
  },
  {
    name: 'galaxy',
    title: 'Galaxy',
    blurb:
      'A spiral galaxy. Root files are the bulge. The rest of the tree is split into two to four arms on logarithmic spirals; every folder is a star cluster, strung along its arm in tree order so a subtree is one stretch of arm.',
    run: galaxy,
  },
];
