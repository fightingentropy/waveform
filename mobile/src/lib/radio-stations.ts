import type { PlayerSong } from "@/types/player";

export type RadioStation = PlayerSong & {
  location: string;
  streamLabel: string;
};

export const RADIO_STATIONS: RadioStation[] = [
  {
    id: "radio:dromos-89-8",
    title: "Dromos 89.8",
    artist: "Athens, Greece",
    album: "Radio Stations",
    location: "Athens, Greece",
    streamLabel: "AAC+ 160 kbps",
    imageUrl: "https://e-radio.github.io/station-icons/89-8-dromos-89-8-athens.webp",
    audioUrl: "https://netradio.live24.gr/dromos2",
    source: "radio",
  },
  {
    id: "radio:bbc-radio-1",
    title: "BBC Radio 1",
    artist: "London, United Kingdom",
    album: "Radio Stations",
    location: "London, United Kingdom",
    streamLabel: "HLS 96 kbps",
    imageUrl: "https://sounds.files.bbci.co.uk/3.9.4/networks/bbc_radio_one/blocks-colour_600x600.png",
    audioUrl:
      "https://a.files.bbci.co.uk/ms6/live/3441A116-B12E-4D2F-ACA8-C1984642FA4B/audio/simulcast/hls/nonuk/audio_syndication_low_sbr_v1/cfs/bbc_radio_one.m3u8",
    source: "radio",
  },
];
