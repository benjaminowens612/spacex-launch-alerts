// Fake Launch Library 2.3.0 "detailed" launch objects, with times relative to
// `now`, for tests and for previewing the app offline (npm run build:fixture).

const H = 3600 * 1000;
const D = 24 * H;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

const SPACEX = { id: 121, name: 'SpaceX', abbrev: 'SpX', type: { id: 3, name: 'Commercial' } };
const STATUS = {
  Go: { id: 1, name: 'Go for Launch', abbrev: 'Go' },
  TBD: { id: 2, name: 'To Be Determined', abbrev: 'TBD' },
  TBC: { id: 8, name: 'To Be Confirmed', abbrev: 'TBC' },
  Success: { id: 3, name: 'Launch Successful', abbrev: 'Success' },
};
const PREC = {
  MIN: { id: 1, name: 'Minute', abbrev: 'MIN' },
  HR: { id: 2, name: 'Hour', abbrev: 'HR' },
  DAY: { id: 5, name: 'Day', abbrev: 'DAY' },
  MONTH: { id: 7, name: 'Month', abbrev: 'M' },
};
const CONFIG = {
  f9: { id: 164, name: 'Falcon 9', full_name: 'Falcon 9 Block 5', variant: 'Block 5' },
  fh: { id: 161, name: 'Falcon Heavy', full_name: 'Falcon Heavy', variant: '' },
  ss: { id: 464, name: 'Starship', full_name: 'Starship', variant: '' },
};
const PAD = {
  slc40: { id: 80, name: 'Space Launch Complex 40', location: { id: 12, name: 'Cape Canaveral SFS, FL, USA' } },
  lc39a: { id: 87, name: 'Launch Complex 39A', location: { id: 27, name: 'Kennedy Space Center, FL, USA' } },
  slc4e: { id: 16, name: 'Space Launch Complex 4E', location: { id: 11, name: 'Vandenberg SFB, CA, USA' } },
  starbase: { id: 188, name: 'Orbital Launch Mount A', location: { id: 143, name: 'SpaceX Starbase, TX, USA' } },
};

function launch({ id, name, config, mission, type, orbit, status, prec, net, windowMin = 0, pad, vid, prob, updated }) {
  return {
    id,
    url: `https://ll.thespacedevs.com/2.3.0/launches/${id}/`,
    name: `${CONFIG[config].full_name} | ${mission}`,
    status: STATUS[status],
    last_updated: iso(updated),
    net: iso(net),
    net_precision: PREC[prec],
    window_start: iso(net),
    window_end: iso(net + windowMin * 60000),
    probability: prob ?? null,
    image: { id: 1, image_url: 'https://example.com/full.jpg', thumbnail_url: 'https://example.com/thumb.jpg' },
    launch_service_provider: SPACEX,
    rocket: { id: 1, configuration: CONFIG[config] },
    mission: {
      id: 1,
      name: mission,
      type,
      description: `${mission} mission description.`,
      orbit: { id: 8, name: orbit, abbrev: '' },
    },
    pad: PAD[pad],
    webcast_live: false,
    vid_urls: vid ? [{ priority: 10, url: vid, title: 'Official webcast' }] : [],
  };
}

export function makeSource(now = new Date()) {
  const t = now.getTime();
  const upcoming = [
    launch({ id: 'a1b2c3d4-0001-4000-8000-000000000001', config: 'f9', mission: 'Starlink Group 10-12', type: 'Communications',
      orbit: 'Low Earth Orbit', status: 'Go', prec: 'MIN', net: t + 5 * H + 17 * 60000, windowMin: 240, pad: 'slc40',
      vid: 'https://x.com/SpaceX', prob: 90, updated: t - 2 * H }),
    launch({ id: 'a1b2c3d4-0002-4000-8000-000000000002', config: 'f9', mission: 'Crew-12', type: 'Human Exploration',
      orbit: 'Low Earth Orbit', status: 'Go', prec: 'MIN', net: t + 1 * D + 9 * H, pad: 'lc39a',
      vid: 'https://www.youtube.com/watch?v=crew12', prob: 75, updated: t - 6 * H }),
    launch({ id: 'a1b2c3d4-0003-4000-8000-000000000003', config: 'f9', mission: 'Transporter-15, Rideshare', type: 'Dedicated Rideshare',
      orbit: 'Sun-Synchronous Orbit', status: 'TBC', prec: 'HR', net: t + 3 * D, windowMin: 60, pad: 'slc4e', updated: t - D }),
    launch({ id: 'a1b2c3d4-0004-4000-8000-000000000004', config: 'ss', mission: 'Flight 12', type: 'Test Flight',
      orbit: 'Suborbital', status: 'TBD', prec: 'DAY', net: t + 9 * D, pad: 'starbase', updated: t - 2 * D }),
    launch({ id: 'a1b2c3d4-0005-4000-8000-000000000005', config: 'fh', mission: 'USSF-75', type: 'Government/Top Secret',
      orbit: 'Geostationary Orbit', status: 'TBD', prec: 'MONTH', net: t + 40 * D, pad: 'lc39a', updated: t - 5 * D }),
    launch({ id: 'a1b2c3d4-0006-4000-8000-000000000006', config: 'f9', mission: 'Starlink Group 11-4', type: 'Communications',
      orbit: 'Low Earth Orbit', status: 'Go', prec: 'MIN', net: t + 2 * D + 3 * H, windowMin: 210, pad: 'slc4e', updated: t - 3 * H }),
  ];
  const previous = [
    launch({ id: 'a1b2c3d4-0099-4000-8000-000000000099', config: 'f9', mission: 'Starlink Group 10-9', type: 'Communications',
      orbit: 'Low Earth Orbit', status: 'Success', prec: 'SEC', net: t - 2 * D, pad: 'slc40', updated: t - 2 * D + H }),
    launch({ id: 'a1b2c3d4-0098-4000-8000-000000000098', config: 'f9', mission: 'Bandwagon-5', type: 'Dedicated Rideshare',
      orbit: 'Low Earth Orbit', status: 'Success', prec: 'MIN', net: t - 20 * D, pad: 'slc40', updated: t - 20 * D }),
  ];
  return { upcoming, previous };
}
