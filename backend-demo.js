'use strict';
// Static demo backend: a small fake library and a player that ticks ElapsedSec. Used to prove the protocol end to end
// before the Plex/Plexamp and BluOS backends exist. Backend contract: { providerName, home(): Node, player, art?(guid) }.
// player: EventEmitter emitting 'state' patches (PlayerState, Title, Artist, Album, TrackSec, ElapsedSec, art, ...).

const EventEmitter = require('events');

class DemoPlayer extends EventEmitter {
  constructor() { super(); this.queue = []; this.i = -1; this.timer = null; this.elapsed = 0; }

  async playTrack(queue, i) {
    this.queue = queue; this.i = i; this._load(true);
  }
  _load(play) {
    const t = this.queue[this.i];
    this.elapsed = 0;
    this.emit('state', { Title: t.title, Artist: t.artist, Album: t.album, TrackNum: this.i + 1, TrackCnt: this.queue.length, TrackSec: t.sec, ElapsedSec: 0, ProgressBar: true,
      ActionsAvailable: ['Ffwd', 'NextTrack', 'Pause', 'Play', 'PlayAll', 'PreviousTrack', 'Seek', 'Stop', 'ThumbsDown', 'ThumbsUp'], Rating: { current: 0, max: 1, system: 1 } });
    if (play) this.play();
  }
  play() {
    if (this.i < 0) return this.playTrack(LIBRARY, 0);
    this.emit('state', { PlayerState: 'playing' });
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.elapsed++;
      if (this.elapsed >= this.queue[this.i].sec) return this.next();
      this.emit('state', { ElapsedSec: this.elapsed });
    }, 1000);
    this.timer.unref();
  }
  // experiment: which Rating values the processor reads back as 'liked'/'disliked' is unverified
  thumbsUp() { this.emit('state', { Rating: { current: 1, max: 1, system: 1 } }); }
  thumbsDown() { this.emit('state', { Rating: { current: -1, max: 1, system: 1 } }); }
  pause() { clearInterval(this.timer); this.emit('state', { PlayerState: 'paused' }); }
  stop() { clearInterval(this.timer); this.elapsed = 0; this.emit('state', { PlayerState: 'stopped', ElapsedSec: 0 }); }
  next() { if (this.i + 1 < this.queue.length) { this.i++; this._load(true); } else this.stop(); }
  prev() { if (this.i > 0) { this.i--; this._load(true); } }
  seek({ sec } = {}) { if (Number.isFinite(sec)) { this.elapsed = sec; this.emit('state', { ElapsedSec: sec }); } }
}

const LIBRARY = [
  { title: 'Highway Blues', artist: 'Demo Artist', album: 'Demo Album', sec: 60 },
  { title: 'Symphony No. 9 (Scherzo)', artist: 'Various Artists', album: 'Beethoven', sec: 75 },
  { title: 'Quiet Piano', artist: 'Demo Artist', album: 'Demo Album', sec: 90 },
];

function createDemoBackend() {
  const player = new DemoPlayer();
  const songItems = () => LIBRARY.map((t, i) => ({
    l1: t.title,
    play: () => player.playTrack(LIBRARY, i),
    context: () => ({ items: [
      { l1: 'Play now', play: () => player.playTrack(LIBRARY, i) },
      { l1: 'Play next', play: () => {} },
    ], functions: ['QuickList', 'Favorites', 'BackToTop'] }),
  }));
  const home = () => ({ title: 'Home Menu', items: [
    { l1: 'My Music', open: () => ({ title: 'My Music', items: [
      { l1: 'Albums', open: () => ({ title: 'Albums', items: [{ l1: 'Demo Album', open: () => ({ title: 'Demo Album', items: songItems() }) }] }) },
      { l1: 'Artists', open: () => ({ title: 'Artists', items: [{ l1: 'Demo Artist', open: () => ({ title: 'Demo Artist', items: songItems() }) }] }) },
      { l1: 'Songs', open: () => ({ title: 'Titles', items: songItems() }) },
    ] }) },
  ] });
  return { providerName: 'Local Music', home, player };
}

module.exports = { createDemoBackend };
