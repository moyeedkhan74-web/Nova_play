/* ============================================================
   🌌 NOVA PLAY 2.0 — script.js
   Production-Quality Master Engine
============================================================ */

const NovaApp = {
  // ── STATE ──
  state: {
    library: { audio: [], video: [], favorites: [] },
    queue: [],
    queueIndex: -1,
    currentMedia: null,
    isPlaying: false,
    isShuffle: false,
    currentSection: 'home',
    subtitles: [],
    controlsTimer: null,
    settings: {
      volume: 1.0,
      brightness: 1.0,
      speed: 1.0,
      autoPlayNext: true,
      showThumbnails: true
    }
  },

  // ── CORE ENGINES ──

  init() {
    const savedTheme = localStorage.getItem('nova-theme');
    if (savedTheme === 'light') document.body.setAttribute('data-theme', 'light');
    const savedPrimary = localStorage.getItem('nova-primary');
    if (savedPrimary) document.documentElement.style.setProperty('--primary', savedPrimary);

    this.ui.initLoading();
    this.ui.updateGreeting();
    this.db.init().then(() => {
      this.loadLibrary().then(() => {
        this.ui.setup();
        this.engine.setup();
        this.gestures.init();
        this.ui.dismissLoading();
      });
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('🌌 Nova Play: Service Worker Active'))
        .catch(err => console.error('Nova SW Error:', err));
    }

    // Launch Queue (Open with Nova Play)
    if ('launchQueue' in window) {
       window.launchQueue.setConsumer(async (params) => {
          const files = [];
          for (const handle of params.files) {
             files.push(await handle.getFile());
          }
          if (files.length > 0) await NovaApp.engine.handleFiles(files);
       });
    }
  },

  async loadLibrary() {
    const all = await this.db.getAllMedia();
    this.state.library.audio = all.filter(m => m.type === 'audio').sort((a,b) => b.dateAdded - a.dateAdded);
    this.state.library.video = all.filter(m => m.type === 'video').sort((a,b) => b.dateAdded - a.dateAdded);
    this.state.library.favorites = all.filter(m => m.isFavorite);
  },

  // ── DATABASE (IndexedDB) ──
  db: {
    instance: null,
    async init() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('NovaPlayMasterDB', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          db.createObjectStore('media', { keyPath: 'id' });
          db.createObjectStore('playlists', { keyPath: 'name' });
        };
        req.onsuccess = (e) => { this.instance = e.target.result; resolve(); };
        req.onerror = (e) => reject(e.target.error);
      });
    },
    async save(item) {
      const tx = this.instance.transaction('media', 'readwrite');
      return tx.objectStore('media').put(item);
    },
    async updatePosition(id, time) {
      const tx = this.instance.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      const req = store.get(id);
      req.onsuccess = () => {
         const item = req.result;
         if (item) {
            item.lastPosition = time;
            store.put(item);
         }
      };
    },
    async getAllMedia() {
      return new Promise(r => {
        const req = this.instance.transaction('media').objectStore('media').getAll();
        req.onsuccess = () => r(req.result);
      });
    },
    async delete(id) {
      const tx = this.instance.transaction('media', 'readwrite');
      tx.objectStore('media').delete(id);
    },
    async addToPlaylist(mediaId, playlistName) {
       const tx = this.instance.transaction(['media', 'playlists'], 'readwrite');
       const mStore = tx.objectStore('media');
       const pStore = tx.objectStore('playlists');
       
       // Update media item to include playlist tag
       const mReq = mStore.get(mediaId);
       mReq.onsuccess = () => {
          const item = mReq.result;
          if (item) {
             if (!item.playlists) item.playlists = [];
             if (!item.playlists.includes(playlistName)) item.playlists.push(playlistName);
             mStore.put(item);
          }
       };

       // Update playlist record
       const pReq = pStore.get(playlistName);
       pReq.onsuccess = () => {
          const playlist = pReq.result || { name: playlistName, mediaIds: [] };
          if (!playlist.mediaIds.includes(mediaId)) playlist.mediaIds.push(mediaId);
          pStore.put(playlist);
       };
    },
    async clear() {
       if (confirm('Wipe all media library data?')) {
          const tx = this.instance.transaction('media', 'readwrite');
          tx.objectStore('media').clear();
          location.reload();
       }
    }
  },

  // ── WEB AUDIO ENGINE (Visualizer + Equalizer) ──
  audioEngine: {
    ctx: null,
    source: null,
    analyser: null,
    filters: {},
    animId: null,
    connected: false,

    init(audioEl) {
       if (this.connected) return; // Already wired up
       try {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          this.source = this.ctx.createMediaElementSource(audioEl);
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 256;

          // 5-Band EQ Filters
          const bands = [
             { id: 'band60', f: 60, type: 'lowshelf' },
             { id: 'band250', f: 250, type: 'peaking' },
             { id: 'band1k', f: 1000, type: 'peaking' },
             { id: 'band4k', f: 4000, type: 'peaking' },
             { id: 'band12k', f: 12000, type: 'highshelf' }
          ];

          let prevNode = this.source;
          bands.forEach(b => {
             const filter = this.ctx.createBiquadFilter();
             filter.type = b.type;
             filter.frequency.value = b.f;
             if (b.type === 'peaking') filter.Q.value = 1.2;
             this.filters[b.id] = filter;
             prevNode.connect(filter);
             prevNode = filter;
          });

          prevNode.connect(this.analyser);
          this.analyser.connect(this.ctx.destination);

          this.connected = true;
          console.log('🎚️ Nova Audio Engine: Connected');
       } catch (e) {
          console.warn('Web Audio init failed:', e);
       }
    },

    setEQ(band, value) {
       if (!this.filters[band]) return;
       this.filters[band].gain.value = parseFloat(value);
    },

    startVisualizer() {
       if (!this.analyser) return;
       const canvas = document.getElementById('audio-visualizer');
       if (!canvas) return;
       const ctx = canvas.getContext('2d');
       const bufferLength = this.analyser.frequencyBinCount;
       const dataArray = new Uint8Array(bufferLength);

       const draw = () => {
          this.animId = requestAnimationFrame(draw);
          this.analyser.getByteFrequencyData(dataArray);

          canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
          canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const w = canvas.width;
          const h = canvas.height;
          const barCount = 48;
          const gap = 3;
          const barWidth = (w - gap * barCount) / barCount;
          const step = Math.floor(bufferLength / barCount);

          for (let i = 0; i < barCount; i++) {
             const value = dataArray[i * step];
             const barHeight = (value / 255) * h * 0.85;
             const x = i * (barWidth + gap);
             const y = h - barHeight;

             // Gradient per bar
             const gradient = ctx.createLinearGradient(x, y, x, h);
             gradient.addColorStop(0, 'rgba(124, 92, 252, 0.9)');
             gradient.addColorStop(0.5, 'rgba(168, 85, 247, 0.5)');
             gradient.addColorStop(1, 'rgba(124, 92, 252, 0.1)');

             ctx.fillStyle = gradient;
             ctx.beginPath();
             ctx.roundRect(x, y, barWidth, barHeight, [4, 4, 0, 0]);
             ctx.fill();
          }
       };
       draw();
    },

    stopVisualizer() {
       if (this.animId) {
          cancelAnimationFrame(this.animId);
          this.animId = null;
       }
       const canvas = document.getElementById('audio-visualizer');
       if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
       }
    },

    resume() {
       if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }
  },

  // ── SLEEP TIMER ──
  sleepTimer: {
    timeout: null,
    set(minutes) {
       clearTimeout(this.timeout);
       if (minutes <= 0) {
          NovaApp.ui.showToast('Sleep timer off');
          return;
       }
       NovaApp.ui.showToast(`Sleep timer: ${minutes} min`);
       this.timeout = setTimeout(() => {
          NovaApp.engine.togglePlay();
          NovaApp.ui.showToast('💤 Sleep timer — Goodnight!');
          document.getElementById('sleep-timer').value = '0';
       }, minutes * 60 * 1000);
    }
  },

  // ── MEDIA ENGINE ──
  engine: {
    players: {
      audio: document.getElementById('main-audio'),
      video: document.getElementById('player-video')
    },

    setup() {
      this.players.audio.onended = () => NovaApp.engine.handleEnded();
      this.players.video.onended = () => NovaApp.engine.handleEnded();
      
      this.players.audio.ontimeupdate = (e) => NovaApp.ui.updateProgress(e.target);
      this.players.video.ontimeupdate = (e) => {
        NovaApp.ui.updateProgress(e.target);
        NovaApp.subtitles.update(e.target.currentTime);
      };

      // Keyboard Shortcuts
      window.onkeydown = (e) => {
        if (e.target.tagName === 'INPUT') return;
        switch(e.code) {
          case 'Space': e.preventDefault(); NovaApp.engine.togglePlay(); break;
          case 'ArrowRight': NovaApp.engine.seek(10); break;
          case 'ArrowLeft': NovaApp.engine.seek(-10); break;
          case 'ArrowUp': e.preventDefault(); this.adjustVolume(0.1); break;
          case 'ArrowDown': e.preventDefault(); this.adjustVolume(-0.1); break;
          case 'KeyW': e.preventDefault(); this.adjustBrightness(0.1); break;
          case 'KeyS': e.preventDefault(); this.adjustBrightness(-0.1); break;
          case 'KeyF': NovaApp.ui.toggleFullscreen(); break;
          case 'KeyM': NovaApp.engine.toggleMute(); break;
          case 'BracketRight': this.adjustSpeed(0.25); break;
          case 'BracketLeft': this.adjustSpeed(-0.25); break;
        }
        if (e.key >= '0' && e.key <= '9') {
           const p = NovaApp.state.currentMedia?.type === 'audio' ? this.players.audio : this.players.video;
           if (p) p.currentTime = p.duration * (parseInt(e.key) / 10);
        }
      };
    },
    adjustVolume(delta) {
       const p = NovaApp.state.currentMedia?.type === 'audio' ? this.players.audio : this.players.video;
       if (!p) return;
       p.volume = Math.max(0, Math.min(1, p.volume + delta));
       NovaApp.state.settings.volume = p.volume;
       NovaApp.ui.showToast(`Volume: ${Math.round(p.volume * 100)}%`);
    },
    adjustBrightness(delta) {
       let newBri = NovaApp.state.settings.brightness + delta;
       newBri = Math.max(0.1, Math.min(1, newBri));
       NovaApp.state.settings.brightness = newBri;
       document.getElementById('video-brightness-overlay').style.opacity = 1 - newBri;
       NovaApp.ui.showGestureFeedback('Brightness', Math.round(newBri * 100) + '%');
       setTimeout(() => NovaApp.ui.hideGestureFeedback(), 1000);
    },
    adjustSpeed(delta) {
       const p = NovaApp.state.currentMedia?.type === 'audio' ? this.players.audio : this.players.video;
       if (!p) return;
       p.playbackRate = Math.max(0.5, Math.min(2, p.playbackRate + delta));
       NovaApp.ui.showToast(`Speed: ${p.playbackRate}x`);
       if (NovaApp.state.currentMedia.type === 'video') document.getElementById('v-speed').value = p.playbackRate;
    },

    async handleFiles(files) {
      NovaApp.ui.showToast(`Importing ${files.length} files...`);
      for (const file of files) {
        const type = file.type.startsWith('video/') ? 'video' : 'audio';
        const media = {
          id: crypto.randomUUID(),
          file,
          name: file.name,
          type,
          duration: 0,
          thumbnail: null,
          dateAdded: Date.now(),
          lastPlayed: null,
          isFavorite: false
        };

        if (type === 'video') {
           try { media.thumbnail = await this.generateThumbnail(file); }
           catch (e) { console.warn('Thumbnail fail', e); }
        }

        media.duration = await this.getDuration(file, type);
        await NovaApp.db.save(media);
      }
      await NovaApp.loadLibrary();
      NovaApp.ui.render();
      NovaApp.ui.showToast('Library updated');
    },

    generateThumbnail(file) {
       return new Promise((resolve) => {
          const video = document.createElement('video');
          const url = URL.createObjectURL(file);
          video.src = url;
          video.muted = true;
          video.currentTime = 3; // Seek to 3s
          
          const timeout = setTimeout(() => {
             URL.revokeObjectURL(url);
             resolve(null);
          }, 5000);

          video.onseeked = () => {
             clearTimeout(timeout);
             const canvas = document.createElement('canvas');
             canvas.width = 320;
             canvas.height = 180;
             canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
             const data = canvas.toDataURL('image/jpeg', 0.6);
             URL.revokeObjectURL(url);
             resolve(data);
          };
          video.onerror = () => {
             clearTimeout(timeout);
             URL.revokeObjectURL(url);
             resolve(null);
          };
       });
    },

    getDuration(file, type) {
      return new Promise(resolve => {
        const el = document.createElement(type);
        el.src = URL.createObjectURL(file);
        el.onloadedmetadata = () => { URL.revokeObjectURL(el.src); resolve(el.duration); };
        el.onerror = () => resolve(0);
      });
    },

    play(id, list = null) {
      const item = [...NovaApp.state.library.audio, ...NovaApp.state.library.video].find(m => m.id === id);
      if (!item) return;

      if (NovaApp.state.currentMedia?.blobUrl) URL.revokeObjectURL(NovaApp.state.currentMedia.blobUrl);

      const url = URL.createObjectURL(item.file);
      item.blobUrl = url;
      NovaApp.state.currentMedia = item;
      
      const p = item.type === 'audio' ? this.players.audio : this.players.video;
      const other = item.type === 'audio' ? this.players.video : this.players.audio;
      
      other.pause();
      p.src = url;
      if (item.lastPosition) p.currentTime = item.lastPosition;
      
      p.play().catch(err => {
         console.error('Play error:', err);
         NovaApp.ui.showToast('Playback error: ' + err.name);
      });
      
      NovaApp.state.isPlaying = true;
      if (list) {
         NovaApp.state.queue = [...list];
         NovaApp.state.queueIndex = NovaApp.state.queue.findIndex(i => i.id === id);
      }

      NovaApp.ui.onMediaStart(item);

      if (item.type === 'audio') {
         NovaApp.audioEngine.init(this.players.audio);
         NovaApp.audioEngine.resume();
         NovaApp.audioEngine.startVisualizer();
      } else {
         NovaApp.audioEngine.stopVisualizer();
      }

      if ('mediaSession' in navigator) {
         let artwork = [];
         if (item.thumbnail) {
            artwork.push({ src: item.thumbnail, sizes: '512x512', type: 'image/jpeg' });
         }
         
         navigator.mediaSession.metadata = new MediaMetadata({
            title: item.name,
            artist: 'Nova Play',
            album: item.type.toUpperCase(),
            artwork: artwork
         });
         navigator.mediaSession.setActionHandler('play', () => NovaApp.engine.togglePlay());
         navigator.mediaSession.setActionHandler('pause', () => NovaApp.engine.togglePlay());
         navigator.mediaSession.setActionHandler('previoustrack', () => NovaApp.engine.prev());
         navigator.mediaSession.setActionHandler('nexttrack', () => NovaApp.engine.next());
         navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.fastSeek && ('fastSeek' in p)) p.fastSeek(details.seekTime);
            else p.currentTime = details.seekTime;
         });
      }
    },

    togglePlay() {
      if (!NovaApp.state.currentMedia) return;
      const p = NovaApp.state.currentMedia.type === 'audio' ? this.players.audio : this.players.video;
      if (p.paused) { 
         p.play().then(() => { 
            NovaApp.state.isPlaying = true; 
            NovaApp.ui.updatePlayIcons(); 
            NovaApp.ui.resetControlsTimer();
            if (NovaApp.state.currentMedia.type === 'audio') {
               NovaApp.audioEngine.resume();
               NovaApp.audioEngine.startVisualizer();
            }
         })
         .catch(err => { NovaApp.ui.showToast('Play failed: ' + err.name); });
      }
      else { 
         p.pause(); 
         NovaApp.state.isPlaying = false; 
         NovaApp.ui.updatePlayIcons(); 
         NovaApp.ui.resetControlsTimer(); // Show controls when paused
         NovaApp.db.updatePosition(NovaApp.state.currentMedia.id, p.currentTime);
      }
    },

    seek(delta) {
      if (!NovaApp.state.currentMedia) return;
      const p = NovaApp.state.currentMedia.type === 'audio' ? this.players.audio : this.players.video;
      p.currentTime = Math.max(0, Math.min(p.duration, p.currentTime + delta));
    },

    next() {
      if (NovaApp.state.queue.length === 0) return;
      let nextIdx = (NovaApp.state.queueIndex + 1) % NovaApp.state.queue.length;
      if (NovaApp.state.isShuffle) nextIdx = Math.floor(Math.random() * NovaApp.state.queue.length);
      NovaApp.engine.play(NovaApp.state.queue[nextIdx].id);
    },

    prev() {
      if (NovaApp.state.queue.length === 0) return;
      let prevIdx = (NovaApp.state.queueIndex - 1 + NovaApp.state.queue.length) % NovaApp.state.queue.length;
      if (NovaApp.state.isShuffle) prevIdx = Math.floor(Math.random() * NovaApp.state.queue.length);
      NovaApp.engine.play(NovaApp.state.queue[prevIdx].id);
    },

    handleEnded() {
      const id = NovaApp.state.currentMedia?.id;
      if (id) NovaApp.db.updatePosition(id, 0); // Clear position on finish

      if (NovaApp.state.repeatMode === 'one') {
         const p = NovaApp.state.currentMedia.type === 'audio' ? this.players.audio : this.players.video;
         p.currentTime = 0;
         p.play();
      } else if (NovaApp.state.settings.autoPlayNext) {
         this.next();
      } else {
         NovaApp.state.isPlaying = false;
         NovaApp.ui.updatePlayIcons();
      }
    },

    toggleFavorite() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       item.isFavorite = !item.isFavorite;
       NovaApp.db.save(item).then(() => {
          NovaApp.loadLibrary().then(() => {
             NovaApp.ui.render();
             NovaApp.ui.showToast(item.isFavorite ? 'Added to Favorites' : 'Removed from Favorites');
          });
       });
    },

    shareCurrent() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       if (navigator.share) {
          navigator.share({ title: item.name, text: 'Check out this media on Nova Play', url: window.location.href });
       } else {
          NovaApp.ui.showToast('Web Share not supported. Info copied.');
       }
    },

    toggleMute() {
       const p = NovaApp.state.currentMedia?.type === 'audio' ? this.players.audio : this.players.video;
       if (p) {
          p.muted = !p.muted;
          NovaApp.ui.showToast(p.muted ? 'Muted' : 'Unmuted');
       }
    },

    async togglePiP() {
       if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
       } else if (this.players.video.readyState >= 2) {
          try { await this.players.video.requestPictureInPicture(); }
          catch (err) { NovaApp.ui.showToast('PiP failed'); }
       }
    },

    removeFromLibrary() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       if (confirm(`Remove ${item.name} from library?`)) {
          NovaApp.db.delete(item.id).then(() => {
             NovaApp.loadLibrary().then(() => {
                NovaApp.ui.closeModals();
                NovaApp.ui.render();
                NovaApp.ui.showToast('Removed');
                document.getElementById('context-menu').hidden = true;
             });
          });
       }
    },
    async addToPlaylistPrompt() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       const name = prompt('Enter Playlist Name (e.g. Chill, Workout):');
       if (name) {
          await NovaApp.db.addToPlaylist(item.id, name);
          NovaApp.ui.showToast(`Added to ${name}`);
          document.getElementById('context-menu').hidden = true;
       }
    },
    cycleRepeatMode() {
       const modes = ['none', 'one', 'all'];
       let idx = modes.indexOf(NovaApp.state.repeatMode);
       NovaApp.state.repeatMode = modes[(idx + 1) % modes.length];
       NovaApp.ui.showToast('Repeat: ' + NovaApp.state.repeatMode);
       document.getElementById('context-menu').hidden = true;
    },
    cycleSpeed() {
       const p = NovaApp.state.currentMedia?.type === 'audio' ? this.players.audio : this.players.video;
       if (!p) return;
       const speeds = [1, 1.25, 1.5, 2, 0.5, 0.75];
       let idx = speeds.indexOf(p.playbackRate);
       p.playbackRate = speeds[(idx + 1) % speeds.length];
       NovaApp.ui.showToast(`Speed: ${p.playbackRate}x`);
       document.getElementById('context-menu').hidden = true;
       if (NovaApp.state.currentMedia.type === 'video') {
          document.getElementById('v-speed').value = p.playbackRate;
       } else {
          const btn = document.getElementById('audio-speed-btn');
          if (btn) btn.textContent = p.playbackRate + 'x';
       }
    }
  },

  // ── GESTURE ENGINE ──
  gestures: {
    startX: 0, startY: 0, currentX: 0, currentY: 0, isDragging: false, mode: null,
    init() {
      const overlay = document.querySelector('.video-ui');
      
      overlay.addEventListener('mousedown', (e) => this.start(e));
      overlay.addEventListener('touchstart', (e) => this.start(e), {passive: true});
      
      window.addEventListener('mousemove', (e) => this.move(e));
      window.addEventListener('touchmove', (e) => this.move(e), {passive: true});
      
      window.addEventListener('mouseup', () => this.end());
      window.addEventListener('touchend', () => this.end());

      // Click to play/pause (if they didn't drag)
      overlay.addEventListener('click', (e) => {
         if (e.target.closest('button') || e.target.closest('.v-seek-track') || e.target.closest('select')) return;
         if (this.mode === null) NovaApp.engine.togglePlay();
      });
    },
    start(e) {
      if (NovaApp.state.currentMedia?.type !== 'video') return;
      if (e.target.closest('button') || e.target.closest('.v-seek-track') || e.target.closest('select')) return;
      
      this.isDragging = true;
      this.startX = e.clientX ?? e.touches?.[0].clientX ?? 0;
      this.startY = e.clientY ?? e.touches?.[0].clientY ?? 0;
      this.currentX = this.startX;
      this.currentY = this.startY;
      this.mode = null;
    },
    move(e) {
      if (!this.isDragging) {
         // Even if not dragging, show controls on move
         NovaApp.ui.resetControlsTimer();
         return;
      }
      this.currentX = e.clientX ?? e.touches?.[0].clientX ?? this.currentX;
      this.currentY = e.clientY ?? e.touches?.[0].clientY ?? this.currentY;
      
      const dx = this.currentX - this.startX;
      const dy = this.currentY - this.startY;

      // Threshold to start detecting a drag (prevents accidental drags on clicks)
      if (!this.mode && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        if (Math.abs(dx) > Math.abs(dy)) this.mode = 'seek';
        else this.mode = (this.startX < window.innerWidth / 2) ? 'brightness' : 'volume';
      }

      if (this.mode === 'seek') {
        const delta = Math.sign(dx) * 10;
        NovaApp.ui.showGestureFeedback('Seek', (delta > 0 ? '+' : '') + delta + 's');
      } else if (this.mode === 'volume') {
        let newVol = NovaApp.state.settings.volume - (dy / window.innerHeight);
        newVol = Math.max(0, Math.min(1, newVol));
        NovaApp.engine.players.video.volume = newVol;
        NovaApp.ui.showGestureFeedback('Volume', Math.round(newVol * 100) + '%');
      } else if (this.mode === 'brightness') {
        let newBri = NovaApp.state.settings.brightness - (dy / window.innerHeight);
        newBri = Math.max(0.1, Math.min(1, newBri));
        NovaApp.state.settings.brightness = newBri;
        // Inverse brightness logic: opacity of black overlay = 1 - brightness
        document.getElementById('video-brightness-overlay').style.opacity = 1 - newBri;
        NovaApp.ui.showGestureFeedback('Brightness', Math.round(newBri * 100) + '%');
      }
    },
    end() {
       if (!this.isDragging) return;
       if (this.mode === 'seek') {
          const dx = this.currentX - this.startX;
          NovaApp.engine.seek(Math.sign(dx) * 10);
       } else if (this.mode === 'volume') {
          const dy = this.currentY - this.startY;
          let newVol = NovaApp.state.settings.volume - (dy / window.innerHeight);
          NovaApp.state.settings.volume = Math.max(0, Math.min(1, newVol));
       } else if (this.mode === 'brightness') {
          const dy = this.currentY - this.startY;
          let newBri = NovaApp.state.settings.brightness - (dy / window.innerHeight);
          NovaApp.state.settings.brightness = Math.max(0.1, Math.min(1, newBri));
       }
       
       this.isDragging = false;
       setTimeout(() => { if (!this.isDragging) NovaApp.ui.hideGestureFeedback(); }, 500);
       
       // Reset mode after a tiny delay so the click handler knows if we dragged
       setTimeout(() => { this.mode = null; }, 50);
    }
  },

  // ── SUBTITLE ENGINE ──
  subtitles: {
    data: [],
    parse(text) {
      const lines = text.split(/\r?\n/);
      const subs = [];
      let current = null;
      lines.forEach(line => {
        if (line.includes(' --> ')) {
          const parts = line.split(' --> ');
          current = { start: this.toSec(parts[0]), end: this.toSec(parts[1]), text: '' };
        } else if (current && line.trim() !== '') {
          current.text += (current.text ? '\n' : '') + line;
        } else if (current && line.trim() === '') {
          subs.push(current);
          current = null;
        }
      });
      this.data = subs;
    },
    toSec(t) {
      const parts = t.replace(',', '.').split(':');
      return parseFloat(parts[0])*3600 + parseFloat(parts[1])*60 + parseFloat(parts[2]);
    },
    update(time) {
      const active = this.data.find(s => time >= s.start && time <= s.end);
      document.getElementById('subtitle-overlay').textContent = active ? active.text : '';
    }
  },

  // ── UI ENGINE ──
  ui: {
    setup() {
      // Nav
      // Navigation (Sidebar & Bottom Nav)
      document.querySelectorAll('.nav-item, .bnav-item').forEach(btn => {
         btn.onclick = () => {
            const section = btn.getAttribute('data-section');
            if (section) this.switchSection(section);
         };
      });

      // Files
      document.getElementById('welcome-scan-btn').onclick = () => {
         document.getElementById('welcome-overlay').hidden = true;
         document.getElementById('file-input').click();
      };
      document.getElementById('welcome-skip-btn').onclick = () => {
         document.getElementById('welcome-overlay').hidden = true;
      };

      document.getElementById('add-media-btn').onclick = () => {
         NovaApp.ui.showToast('Tip: Long-press to select multiple files');
         document.getElementById('file-input').click();
      };
      document.getElementById('file-input').onchange = (e) => NovaApp.engine.handleFiles(e.target.files);
      
      // Subtitles
      document.getElementById('v-subtitles').onclick = () => document.getElementById('subtitle-input').click();
      document.getElementById('subtitle-input').onchange = (e) => {
         const reader = new FileReader();
         reader.onload = (ev) => NovaApp.subtitles.parse(ev.target.result);
         reader.readAsText(e.target.files[0]);
      };
      // Playback Controls
      document.getElementById('mini-prev').onclick = (e) => { e.stopPropagation(); NovaApp.engine.prev(); };
      document.getElementById('audio-prev').onclick = () => NovaApp.engine.prev();
      document.getElementById('mini-play-pause').onclick = (e) => { e.stopPropagation(); NovaApp.engine.togglePlay(); };
      document.getElementById('audio-play-pause').onclick = () => NovaApp.engine.togglePlay();
      document.getElementById('v-play-pause').onclick = () => NovaApp.engine.togglePlay();
      document.getElementById('mini-next').onclick = (e) => { e.stopPropagation(); NovaApp.engine.next(); };
      document.getElementById('audio-next').onclick = () => NovaApp.engine.next();
      document.getElementById('mini-expand').onclick = () => NovaApp.ui.openFullPlayer();
      document.getElementById('mini-player').onclick = (e) => { if (e.target.closest('.mini-btn')) return; NovaApp.ui.openFullPlayer(); };

      // Search
      document.getElementById('search-input').oninput = (e) => this.handleSearch(e.target.value);

      // Hero Play
      document.getElementById('hero-play-btn').onclick = () => {
         const all = [...NovaApp.state.library.audio, ...NovaApp.state.library.video];
         if (all.length > 0) {
            NovaApp.engine.play(all[0].id, all);
         } else {
            document.getElementById('file-input').click();
         }
      };

      // Seek Tracks
      const setupSeek = (id, player) => {
         const el = document.getElementById(id);
         el.onclick = (e) => {
            const rect = el.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            player.currentTime = pct * player.duration;
         };
      };
      setupSeek('mini-progress-track', NovaApp.engine.players.audio);
      setupSeek('audio-seek-track', NovaApp.engine.players.audio);
      setupSeek('video-seek-track', NovaApp.engine.players.video);

      // Speed
      document.getElementById('v-speed').onchange = (e) => {
         NovaApp.engine.players.video.playbackRate = parseFloat(e.target.value);
      };

      // Advanced Buttons
      document.getElementById('v-pip').onclick = () => NovaApp.engine.togglePiP();
      document.getElementById('v-fullscreen').onclick = () => NovaApp.ui.toggleFullscreen();
      
      document.getElementById('audio-shuffle').onclick = () => {
         NovaApp.state.isShuffle = !NovaApp.state.isShuffle;
         NovaApp.ui.showToast(NovaApp.state.isShuffle ? 'Shuffle On' : 'Shuffle Off');
         document.getElementById('audio-shuffle').style.color = NovaApp.state.isShuffle ? 'var(--primary)' : '';
      };
      document.getElementById('audio-repeat').onclick = () => {
         const modes = ['none', 'one', 'all'];
         let idx = modes.indexOf(NovaApp.state.repeatMode);
         NovaApp.state.repeatMode = modes[(idx + 1) % modes.length];
         NovaApp.ui.showToast('Repeat: ' + NovaApp.state.repeatMode);
         document.getElementById('audio-repeat').style.color = NovaApp.state.repeatMode !== 'none' ? 'var(--primary)' : '';
         document.getElementById('audio-repeat').innerHTML = `<svg class="icon"><use href="${NovaApp.state.repeatMode === 'one' ? '#icon-repeat-1' : '#icon-repeat'}"></use></svg>`;
      };

      // Hide context menu on outside click
      document.addEventListener('click', (e) => {
         if (!e.target.closest('.context-menu') && !e.target.closest('.modal-more-btn')) {
            document.getElementById('context-menu').hidden = true;
         }
      });

      // Drag & Drop
      const dropZone = document.getElementById('content-scroll');
      dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.background = 'rgba(124, 92, 252, 0.05)'; };
      dropZone.ondragleave = () => { dropZone.style.background = ''; };
      dropZone.ondrop = (e) => {
         e.preventDefault();
         dropZone.style.background = '';
         if (e.dataTransfer.files.length) NovaApp.engine.handleFiles(e.dataTransfer.files);
      };

      // Window resize for marquee recalculation
      window.addEventListener('resize', () => {
         if (NovaApp.state.currentMedia?.type === 'audio') {
            NovaApp.ui.updateMarquee('mini-title', NovaApp.state.currentMedia.name, true);
            if (!document.getElementById('audio-modal').hidden) {
               NovaApp.ui.updateMarquee('audio-title-large', NovaApp.state.currentMedia.name, true);
            }
         }
      });

      this.render();
    },

    render() {
      this.renderGrid('recent-grid', [...NovaApp.state.library.audio, ...NovaApp.state.library.video].slice(0, 4));
      this.renderGrid('new-grid', [...NovaApp.state.library.audio, ...NovaApp.state.library.video]);
      this.renderGrid('music-grid', NovaApp.state.library.audio);
      this.renderGrid('video-grid', NovaApp.state.library.video);
      this.renderGrid('favorites-grid', NovaApp.state.library.favorites);
      this.renderPlaylists();
    },

    renderPlaylists() {
       const el = document.getElementById('playlists-grid');
       if (!el) return;
       const playlists = [...new Set([...NovaApp.state.library.audio, ...NovaApp.state.library.video].flatMap(i => i.playlists || []))];
       if (playlists.length === 0) { el.innerHTML = '<div class="empty">No playlists created</div>'; return; }
       el.innerHTML = playlists.map(p => `
          <div class="media-card" onclick="NovaApp.ui.openPlaylist('${p}')">
             <div class="card-art" style="background: var(--primary-glow);"><svg class="icon" style="width:40px;height:40px;"><use href="#icon-list"></use></svg></div>
             <div class="card-info">
                <h4 class="card-title">${p}</h4>
                <p class="card-artist">Custom Playlist</p>
             </div>
          </div>
       `).join('');
    },

    toggleTheme() {
       const isDark = document.body.getAttribute('data-theme') !== 'light';
       document.body.setAttribute('data-theme', isDark ? 'light' : 'dark');
       localStorage.setItem('nova-theme', isDark ? 'light' : 'dark');
    },

    setPrimary(color) {
       document.documentElement.style.setProperty('--primary', color);
       localStorage.setItem('nova-primary', color);
    },

    openPlaylist(name) {
       const all = [...NovaApp.state.library.audio, ...NovaApp.state.library.video];
       const filtered = all.filter(i => i.playlists && i.playlists.includes(name));
       
       const el = document.getElementById('playlists-grid');
       el.innerHTML = `
          <div style="grid-column: 1/-1; display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
             <button onclick="NovaApp.ui.renderPlaylists()" class="btn-ghost" style="padding: 4px 12px;">← Back</button>
             <h3 style="font-family: var(--font-heading);">${name}</h3>
          </div>
       `;
       this.renderGrid('playlists-grid', filtered, true);
    },

    renderGrid(id, items, isPlaylist = false) {
       const el = document.getElementById(id);
       if (!el) return;
       if (items.length === 0) { el.innerHTML = '<div class="empty">Library empty</div>'; return; }
       el.innerHTML = items.map(i => {
         const art = i.thumbnail ? `<img src="${i.thumbnail}" alt="thumb" style="width:100%;height:100%;object-fit:cover;">` : `<svg class="icon" style="width:24px;height:24px;"><use href="#icon-${i.type === 'audio' ? 'music' : 'video'}"></use></svg>`;
         const size = (i.file.size / (1024 * 1024)).toFixed(1) + ' MB';
         return `
           <div class="media-card" onclick="NovaApp.engine.play('${i.id}', NovaApp.state.library.${i.type})">
             <div class="card-art">${art}</div>
             <div class="card-info">
                <h4 class="card-title">${i.name}</h4>
                <p class="card-artist">${i.type.toUpperCase()} • ${this.formatTime(i.duration)} • ${size}</p>
             </div>
             <button class="card-more-btn" onclick="event.stopPropagation(); NovaApp.state.currentMedia = NovaApp.state.library.${i.type}.find(m=>m.id==='${i.id}'); NovaApp.ui.showContextMenu(event, this)">
                <svg class="icon"><use href="#icon-more"></use></svg>
             </button>
           </div>
         `;
       }).join('');
    },

    onMediaStart(item) {
       this.updatePlayIcons();
       document.getElementById('mini-player').classList.add('active');
       
       // Call updates after a short delay to ensure DOM dimensions are ready
       setTimeout(() => {
          this.updateMarquee('mini-title', item.name, item.type === 'audio');
          document.getElementById('mini-artist').textContent = item.type.toUpperCase();

          if (item.type === 'audio') {
             this.updateMarquee('audio-title-large', item.name, true);
             document.getElementById('audio-artist-large').textContent = 'LOCAL FILE';
             const btn = document.getElementById('audio-speed-btn');
             if (btn) btn.textContent = NovaApp.engine.players.audio.playbackRate + 'x';
          } else {
             const vTitle = document.getElementById('video-title-top');
             vTitle.textContent = item.name;
             vTitle.classList.remove('marquee-scrolling');
             vTitle.style.transform = '';
             document.getElementById('video-brightness-overlay').style.opacity = 1 - NovaApp.state.settings.brightness;
             this.resetControlsTimer();
          }
       }, 50);

       this.openFullPlayer();
    },

    updatePlayIcons() {
       const iconId = NovaApp.state.isPlaying ? '#icon-pause' : '#icon-play';
       document.getElementById('mini-play-pause').innerHTML = `<svg class="icon"><use href="${iconId}"></use></svg>`;
       document.getElementById('audio-play-pause').innerHTML = `<svg class="icon"><use href="${iconId}"></use></svg>`;
       document.getElementById('v-play-pause').innerHTML = `<svg class="icon"><use href="${iconId}"></use></svg>`;
    },

    updateProgress(player) {
       const pct = (player.currentTime / player.duration) * 100;
       document.getElementById('mini-progress-fill').style.width = pct + '%';
       if (NovaApp.state.currentMedia.type === 'audio') {
          document.getElementById('audio-seek-fill').style.width = pct + '%';
          document.getElementById('audio-current-time').textContent = this.formatTime(player.currentTime);
          document.getElementById('audio-duration').textContent = this.formatTime(player.duration);
       } else {
          document.getElementById('video-seek-fill').style.width = pct + '%';
          document.getElementById('v-time').textContent = `${this.formatTime(player.currentTime)} / ${this.formatTime(player.duration)}`;
       }
    },

    updateMarquee(id, text, shouldScroll = true) {
       const el = document.getElementById(id);
       if (!el) return;
       el.textContent = text;
       el.classList.remove('marquee-scrolling');
       el.style.transform = '';
       el.parentElement.style.textAlign = 'center';
       
       // Force reflow
       void el.offsetWidth;
       
       if (shouldScroll && el.scrollWidth > el.parentElement.clientWidth) {
          el.classList.add('marquee-scrolling');
          el.parentElement.style.textAlign = 'left';
          const dur = Math.max(10, el.scrollWidth / 30);
          el.style.animationDuration = `${dur}s`;
       } else {
          el.style.animationDuration = '';
       }
    },

    showControls(show) {
       const ui = document.querySelector('.video-ui');
       if (ui) ui.classList.toggle('hidden', !show);
       if (show) this.resetControlsTimer();
    },

    resetControlsTimer() {
       clearTimeout(NovaApp.state.controlsTimer);
       const ui = document.querySelector('.video-ui');
       if (ui) ui.classList.remove('hidden');
       
       if (NovaApp.state.isPlaying && NovaApp.state.currentMedia?.type === 'video') {
          NovaApp.state.controlsTimer = setTimeout(() => {
             const ui = document.querySelector('.video-ui');
             if (ui) ui.classList.add('hidden');
          }, 4000);
       }
    },

    openFullPlayer() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       if (item.type === 'audio') document.getElementById('audio-modal').hidden = false;
       else document.getElementById('video-modal').hidden = false;
    },

    closeModals() {
       document.getElementById('audio-modal').hidden = true;
       document.getElementById('video-modal').hidden = true;
       document.getElementById('audio-eq-overlay').hidden = true;
       if (NovaApp.state.currentMedia?.type === 'video' && NovaApp.state.isPlaying) {
          NovaApp.engine.togglePlay();
       }
    },

    toggleAudioEQ() {
       const overlay = document.getElementById('audio-eq-overlay');
       overlay.hidden = !overlay.hidden;
    },

    handleSearch(query) {
       const q = query.toLowerCase().trim();
       const sid = NovaApp.state.currentSection;
       
       if (sid === 'home') {
          const filteredAudio = NovaApp.state.library.audio.filter(m => m.name.toLowerCase().includes(q));
          const filteredVideo = NovaApp.state.library.video.filter(m => m.name.toLowerCase().includes(q));
          this.renderGrid('recent-grid', [...filteredAudio, ...filteredVideo].slice(0, 10));
       } else if (sid === 'music') {
          const filtered = NovaApp.state.library.audio.filter(m => m.name.toLowerCase().includes(q));
          this.renderGrid('music-grid', filtered);
       } else if (sid === 'videos') {
          const filtered = NovaApp.state.library.video.filter(m => m.name.toLowerCase().includes(q));
          this.renderGrid('video-grid', filtered);
       } else if (sid === 'favorites') {
          const filtered = NovaApp.state.library.favorites.filter(m => m.name.toLowerCase().includes(q));
          this.renderGrid('favorites-grid', filtered);
       }
    },

    history: ['home'],
    goBack() {
       if (this.history.length > 1) {
          this.history.pop();
          const prev = this.history[this.history.length - 1];
          this.switchSection(prev, true);
       }
    },
    switchSection(sid, isBack = false) {
       if (!isBack && sid !== this.history[this.history.length - 1]) {
          this.history.push(sid);
       }
       document.querySelectorAll('.app-section').forEach(s => s.hidden = true);
       const target = document.getElementById(`section-${sid}`);
       if (target) target.hidden = false;
       document.querySelectorAll('.nav-item, .bnav-item').forEach(b => b.classList.toggle('active', b.getAttribute('data-section') === sid));
       NovaApp.state.currentSection = sid;
       const scroll = document.getElementById('content-scroll');
       if (scroll) scroll.scrollTop = 0;
       
       const backBtn = document.getElementById('mobile-back-btn');
       const logo = document.getElementById('mobile-logo');
       if (backBtn && logo) {
          if (sid === 'home') {
             backBtn.style.setProperty('display', 'none', 'important');
             logo.style.setProperty('display', 'flex', 'important');
          } else {
             backBtn.style.setProperty('display', 'flex', 'important');
             logo.style.setProperty('display', 'none', 'important');
          }
       }
    },

    triggerFilePicker() {
       document.getElementById('file-input').click();
    },

    showContextMenu(e, target) {
       const menu = document.getElementById('context-menu');
       menu.hidden = false;
       // Position menu
       let x = e.clientX;
       let y = e.clientY;
       if (x + 180 > window.innerWidth) x = window.innerWidth - 190;
       if (y + 200 > window.innerHeight) y = window.innerHeight - 210;
       menu.style.left = x + 'px';
       menu.style.top = y + 'px';
    },

    showFileInfo() {
       const item = NovaApp.state.currentMedia;
       if (!item) return;
       const sizeMB = (item.size / (1024 * 1024)).toFixed(2);
       
       document.getElementById('info-name').textContent = item.name;
       document.getElementById('info-type').textContent = item.type.toUpperCase();
       document.getElementById('info-duration').textContent = this.formatTime(item.duration);
       document.getElementById('info-size').textContent = `${sizeMB} MB`;
       
       document.getElementById('info-modal').hidden = false;
       document.getElementById('context-menu').hidden = true;
    },

    toggleFullscreen() {
       const container = document.getElementById('video-container');
       if (!document.fullscreenElement) {
          container.requestFullscreen().catch(err => {
             this.showToast(`Error attempting to enable full-screen mode: ${err.message}`);
          });
       } else {
          document.exitFullscreen();
       }
    },

    showToast(msg) {
       const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
       document.getElementById('toast-container').appendChild(t);
       setTimeout(() => t.remove(), 3000);
    },

    showGestureFeedback(icon, val) {
       const el = document.getElementById('gesture-feedback');
       el.hidden = false;
       let iconHtml = '';
       if (icon === 'Volume') iconHtml = '<svg class="icon" style="width:32px;height:32px;"><use href="#icon-volume"></use></svg>';
       else if (icon === 'Brightness') iconHtml = '<svg class="icon" style="width:32px;height:32px;"><use href="#icon-sun"></use></svg>';
       else iconHtml = '<svg class="icon" style="width:32px;height:32px;"><use href="#icon-fast-forward"></use></svg>';
       
       el.querySelector('.feedback-icon').innerHTML = iconHtml;
       el.querySelector('.feedback-value').textContent = val;
    },
    hideGestureFeedback() { document.getElementById('gesture-feedback').hidden = true; },

    formatTime(s) {
       if (isNaN(s) || s < 0) return '0:00';
       const h = Math.floor(s / 3600);
       const m = Math.floor((s % 3600) / 60);
       const s1 = Math.floor(s % 60);
       if (h > 0) {
          return `${h}:${m.toString().padStart(2, '0')}:${s1.toString().padStart(2, '0')}`;
       }
       return `${m}:${s1.toString().padStart(2, '0')}`;
    },

    initLoading() {
       // Starfield Particle Canvas
       const cvs = document.getElementById('particle-canvas');
       if (cvs) {
         const ctx = cvs.getContext('2d');
         let w = window.innerWidth;
         let h = window.innerHeight;
         cvs.width = w; cvs.height = h;
         const particles = [];
         
         for (let i = 0; i < 80; i++) {
           particles.push({
             x: Math.random() * w, y: Math.random() * h,
             r: Math.random() * 1.5 + 0.5,
             vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
             alpha: Math.random() * 0.6 + 0.1,
             glow: Math.random() > 0.8
           });
         }
         
         let animId;
         const draw = () => {
           ctx.clearRect(0, 0, w, h);
           particles.forEach(p => {
             p.x += p.vx; p.y += p.vy;
             if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
             if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
             
             ctx.beginPath();
             ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
             ctx.fillStyle = p.glow ? `rgba(92, 248, 252, ${p.alpha})` : `rgba(124, 92, 252, ${p.alpha})`;
             if (p.glow) {
               ctx.shadowBlur = 8;
               ctx.shadowColor = '#5CF8FC';
             } else {
               ctx.shadowBlur = 0;
             }
             ctx.fill();
           });
           animId = requestAnimationFrame(draw);
         };
         draw();

         // Stop animation after fade out to save CPU
         setTimeout(() => cancelAnimationFrame(animId), 3000);
         
         window.addEventListener('resize', () => {
           if(!document.getElementById('loading-screen').classList.contains('fade-out')) {
             w = cvs.width = window.innerWidth; h = cvs.height = window.innerHeight;
           }
         });
       }

       // Progress Bar Logistics
       const fill = document.getElementById('loading-bar-fill');
       const status = document.getElementById('loading-status');
       let p = 0; 
       const messages = ["Booting Core...", "Connecting Database...", "Loading Library...", "Ready."];
       
       const int = setInterval(() => { 
         p += Math.random() * 15 + 5; 
         if (p >= 100) p = 100;
         if (fill) fill.style.width = p + '%'; 
         
         if (p < 30) status.textContent = messages[0];
         else if (p < 60) status.textContent = messages[1];
         else if (p < 90) status.textContent = messages[2];
         else status.textContent = messages[3];

         if (p >= 100) clearInterval(int); 
       }, 120);
    },
    updateGreeting() {
      const hour = new Date().getHours();
      let g = "Good Night";
      if (hour < 12) g = "Good Morning";
      else if (hour < 17) g = "Good Afternoon";
      else if (hour < 21) g = "Good Evening";
      const el = document.getElementById('hero-greeting');
      if (el) el.textContent = g;
    },
    dismissLoading() { 
       setTimeout(() => {
          document.getElementById('loading-screen').classList.add('fade-out');
          // Only show Welcome Overlay on Mobile/Tablet
          if (window.innerWidth < 1024 && NovaApp.state.library.audio.length === 0 && NovaApp.state.library.video.length === 0) {
             const welcome = document.getElementById('welcome-overlay');
             if (welcome) welcome.hidden = false;
          }
       }, 1500); 
    }
  }
};

window.onload = () => NovaApp.init();
