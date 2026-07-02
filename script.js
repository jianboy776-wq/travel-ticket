const $ = selector => document.querySelector(selector);
const ticket = $('#ticket');
const ticketWrap = $('#ticket-wrap');
const empty = $('#empty');
const memory = $('#memory');
const photo = $('#ticket-photo');
const editor = $('#editor');
const downloadMenu = $('#download-menu');
const memoryInput = $('#memory-upload');
const videoInput = $('#video-upload');
const createButton = $('#create-ticket');
const toast = $('#toast');
const pageTurnCanvas = $('#page-turn-overlay');
let playbackResetTimer = null;
let pageTurnPreviewFrame = 0;
let pageTurnFramesPromise = null;
let pageTurnFrames = [];
const TICKET_TEAR_SECONDS = 1;
const TICKET_OUTRO_SECONDS = .28;
const PHOTO_PLAY_SECONDS = 7.6;
const EXPORT_TICKET_Y = 356;
const LIVE_CROP_TOP = 318;
let ffmpegRuntimePromise = null;

const state = {
  custom: false,
  coverFile: null,
  memoryFiles: [],
  imageFile: null,
  videoFile: null,
  motionBlob: null,
  androidMotion: false,
  coverUrl: null,
  memoryUrl: null,
  videoUrl: null,
  draftCoverUrl: null,
  frameVideoUrl: null,
  coverMode: 'fill',
  coverX: 50,
  coverY: 50,
  coverZoom: 115,
  palette: null,
  city: 'GUANGZHOU',
  date: '2026 · 02'
};

$('#stub').addEventListener('click', openTicket);
$('.close-memory').addEventListener('click', closeTicket);
$('#edit-ticket').addEventListener('click', openEditor);
$('#new-ticket').addEventListener('click', openEditor);
$('#delete-ticket').addEventListener('click', deleteTicket);
$('#download-ticket').addEventListener('click', () => openModal(downloadMenu));
$('#export-live').addEventListener('click', exportLive);
$('#export-apple-live').addEventListener('click', exportAppleLive);
$('#export-video').addEventListener('click', exportVideo);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal($('#' + button.dataset.close))));
setTimeout(() => ensurePageTurnFrames(), 0);

memoryInput.addEventListener('change', () => handleMemorySelection([...(memoryInput.files || [])]));
videoInput.addEventListener('change', () => handleMemorySelection([...(videoInput.files || [])]));

async function handleMemorySelection(files) {
  state.memoryFiles = files;
  $('#memory-label').textContent = state.memoryFiles.length ? `${state.memoryFiles.length} 个文件` : '选择';
  if (!state.memoryFiles.length) return;
  const imageFile = state.memoryFiles.find(isImage) || null;
  const videoFile = state.memoryFiles.find(isVideo) || null;
  state.imageFile = imageFile;
  state.videoFile = videoFile;
  state.motionBlob = null;
  state.androidMotion = false;
  $('#memory-label').textContent = '正在读取…';
  try {
    if (!videoFile && imageFile) {
      state.motionBlob = await extractAndroidMotionVideo(imageFile);
      state.androidMotion = Boolean(state.motionBlob);
    }
    state.coverFile = imageFile || null;
    const movingSource = videoFile || state.motionBlob;
    if (movingSource) {
      try {
        // Prefer the phone/computer's decoder. The large fallback is loaded only when needed.
        await prepareFramePicker(movingSource, imageFile, 5000);
      } catch (directError) {
        $('#memory-label').textContent = '正在转换兼容格式…';
        const compatibleVideo = await normalizeVideoForBrowser(movingSource);
        if (videoFile) state.videoFile = compatibleVideo;
        else state.motionBlob = compatibleVideo;
        await prepareFramePicker(compatibleVideo, imageFile, 10000);
      }
    }
    else {
      hideFramePicker();
      await setDraftCover(imageFile);
    }
    if (!state.coverFile) throw new Error('No usable cover frame');
    resetCoverDesign();
    $('#memory-label').textContent = `${state.memoryFiles.length} 个文件`;
    showWizardStep('cover');
  } catch (error) {
    console.error(error);
    window.__lastMediaError = String(error?.stack || error);
    $('#memory-label').textContent = '重新选择';
    showToast('无法读取该素材的定格画面，请换一个文件');
  }
}

async function normalizeVideoForBrowser(file) {
  if (await isHevcVideoFile(file)) return transcodeHevcWithFfmpeg(file);
  try {
    return await transcodeVideoWithWebCodecs(file);
  } catch (webCodecsError) {
    console.warn('Browser decoder could not read this video; using HEVC fallback.', webCodecsError);
    return transcodeHevcWithFfmpeg(file);
  }
}

async function isHevcVideoFile(file) {
  const probeSize = Math.min(file.size, 8 * 1024 * 1024);
  const parts = [file.slice(0, probeSize)];
  if (file.size > probeSize) parts.push(file.slice(file.size - probeSize));
  for (const part of parts) {
    const bytes = new Uint8Array(await part.arrayBuffer());
    for (let i = 0; i <= bytes.length - 4; i++) {
      if ((bytes[i] === 0x68 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x31) ||
          (bytes[i] === 0x68 && bytes[i + 1] === 0x65 && bytes[i + 2] === 0x76 && bytes[i + 3] === 0x31)) return true;
    }
  }
  return false;
}

async function transcodeVideoWithWebCodecs(file) {
  if (!('VideoDecoder' in window) || !('VideoEncoder' in window)) throw new Error('WebCodecs unavailable');
  const {
    Input, Output, ALL_FORMATS, BlobSource, Mp4OutputFormat,
    BufferTarget, Conversion
  } = await import('https://cdn.jsdelivr.net/npm/mediabunny@1.50.2/+esm');
  const input = new Input({formats:ALL_FORMATS, source:new BlobSource(file)});
  if (!(await input.canRead())) throw new Error('Unsupported video container');
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found');
  const sourceWidth = await track.getDisplayWidth();
  const target = new BufferTarget();
  const output = new Output({format:new Mp4OutputFormat(), target});
  const conversion = await Conversion.init({
    input,
    output,
    video:{
      codec:'avc',
      bitrate:2_500_000,
      width:Math.max(640, Math.min(sourceWidth || 1280, 1280)),
      frameRate:30,
      forceTranscode:true,
      hardwareAcceleration:'no-preference'
    },
    audio:{discard:true},
    tracks:'primary'
  });
  if (!conversion.isValid) throw new Error(`Video cannot be decoded: ${conversion.discardedTracks.map(item => item.reason).join(', ')}`);
  conversion.onProgress = progress => {
    $('#memory-label').textContent = `正在转换 ${Math.round(progress * 100)}%`;
  };
  await conversion.execute();
  if (!target.buffer) throw new Error('Video conversion produced no output');
  return new File([target.buffer], 'compatible-video.mp4', {type:'video/mp4'});
}

async function transcodeHevcWithFfmpeg(file) {
  $('#memory-label').textContent = '正在读取 H.265 视频…';
  const ffmpeg = await getFfmpegRuntime();
  ffmpeg.on('progress', ({progress}) => {
    const percent = Math.max(0, Math.min(99, Math.round(progress * 100)));
    $('#memory-label').textContent = `正在转换 H.265 视频 ${percent}%`;
  });
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputName = `selected-${nonce}.mp4`;
  const outputName = `compatible-${nonce}.mp4`;
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  const exitCode = await ffmpeg.exec([
    '-i', inputName,
    '-map', '0:v:0',
    '-vf', 'scale=min(960\\,iw):-2',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '27',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an', outputName
  ]);
  if (exitCode !== 0) throw new Error(`HEVC conversion failed (${exitCode})`);
  const bytes = await ffmpeg.readFile(outputName);
  const stableBytes = new Uint8Array(bytes.length);
  stableBytes.set(bytes);
  await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)]);
  if (!stableBytes.length) throw new Error('HEVC conversion produced no output');
  return new File([stableBytes.buffer], outputName, {type:'video/mp4'});
}

async function getFfmpegRuntime() {
  if (!ffmpegRuntimePromise) {
    ffmpegRuntimePromise = (async () => {
      $('#memory-label').textContent = '首次加载 H.265 读取组件…';
      const [{FFmpeg}, {toBlobURL}] = await Promise.all([
        import('./vendor/ffmpeg/index.js'),
        import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js')
      ]);
      const ffmpeg = new FFmpeg();
      const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm')
      });
      return ffmpeg;
    })().catch(error => {
      ffmpegRuntimePromise = null;
      throw error;
    });
  }
  return ffmpegRuntimePromise;
}

$('#frame-range').addEventListener('input', () => {
  const video = $('#cover-frame-video');
  if (!Number.isFinite(video.duration) || !video.duration) return;
  video.currentTime = (Number($('#frame-range').value) / 1000) * video.duration;
  $('#frame-time').textContent = formatTime(video.currentTime);
});

$('#cover-frame-video').addEventListener('seeked', async () => {
  try {
    const file = await captureFrameElement($('#cover-frame-video'));
    state.coverFile = file;
    await setDraftCover(file, true);
  } catch (error) {
    console.warn('Frame capture failed', error);
  }
});

$('#back-to-media').addEventListener('click', () => showWizardStep('media'));

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  createButton.textContent = '正在处理动态照片…';
  await buildTicket();
  createButton.textContent = '完成并展示';
  createButton.disabled = false;
  closeModal(editor);
  showToast(state.videoFile || state.motionBlob ? '动态票根已生成' : '照片票根已生成');
});

function openEditor() {
  showWizardStep('media');
  openModal(editor);
}

document.querySelectorAll('[data-cover-mode]').forEach(button => button.addEventListener('click', () => {
  state.coverMode = button.dataset.coverMode;
  document.querySelectorAll('[data-cover-mode]').forEach(item => item.classList.toggle('active', item === button));
  $('#crop-controls').hidden = state.coverMode === 'fit';
  $('#cover-advice').textContent = state.coverMode === 'fit' ? '完整照片会保留，空余部分用模糊背景自然补齐。' : '可移动和放大画面，让主体落在票根中央。';
  updateCoverPreview();
}));

['cover-x','cover-y','cover-zoom'].forEach(id => $('#' + id).addEventListener('input', () => {
  state.coverX = Number($('#cover-x').value);
  state.coverY = Number($('#cover-y').value);
  state.coverZoom = Number($('#cover-zoom').value);
  updateCoverPreview();
}));

function resetCoverDesign() {
  state.coverMode = 'fill'; state.coverX = 50; state.coverY = 50; state.coverZoom = 115;
  $('#cover-x').value = 50; $('#cover-y').value = 50; $('#cover-zoom').value = 115;
  $('#crop-controls').hidden = false;
  document.querySelectorAll('[data-cover-mode]').forEach(item => item.classList.toggle('active', item.dataset.coverMode === 'fill'));
  updateCoverPreview();
}

function updateCoverPreview() {
  const preview = $('#cover-preview');
  const image = $('#cover-frame-video').hidden ? $('#cover-preview-image') : $('#cover-frame-video');
  preview.classList.toggle('fit', state.coverMode === 'fit');
  image.style.objectPosition = `${state.coverX}% ${state.coverY}%`;
  image.style.transform = coverTransform();
}

function coverTransform() {
  if (state.coverMode === 'fit') return 'scale(1) translate(0, 0)';
  const scale = state.coverZoom / 100;
  const limit = ((scale - 1) / (2 * scale)) * 100;
  const x = ((50 - state.coverX) / 50) * limit;
  const y = ((50 - state.coverY) / 50) * limit;
  return `scale(${scale}) translate(${x}%, ${y}%)`;
}

function showWizardStep(step) {
  $('#media-step').hidden = step !== 'media';
  $('#cover-step').hidden = step !== 'cover';
  $('#editor-title').textContent = step === 'media' ? '选择回忆' : '设计票根封面';
}

async function buildTicket() {
  revokeUrls();
  state.imageFile = state.imageFile || state.memoryFiles.find(isImage) || null;
  state.videoFile = state.videoFile || state.memoryFiles.find(isVideo) || null;

  if (!state.videoFile && state.imageFile && !state.motionBlob) {
    state.motionBlob = await extractAndroidMotionVideo(state.imageFile);
    state.androidMotion = Boolean(state.motionBlob);
  }

  state.coverUrl = URL.createObjectURL(state.coverFile);
  state.memoryUrl = state.imageFile ? URL.createObjectURL(state.imageFile) : state.coverUrl;
  const playable = state.videoFile || state.motionBlob;
  state.videoUrl = playable ? URL.createObjectURL(playable) : null;
  state.city = ($('#city-input').value || 'MY TRIP').trim().toUpperCase();
  state.date = ($('#date-input').value || '').trim();
  state.custom = true;
  const paletteSource = await loadVisual(state.coverFile);
  state.palette = samplePalette(paletteSource);
  applyTheme(state.palette);

  photo.style.backgroundImage = `url("${state.coverUrl}")`;
  photo.classList.add('custom');
  photo.classList.toggle('fit', state.coverMode === 'fit');
  const ticketCover = $('#ticket-cover-image');
  ticketCover.src = state.coverUrl;
  ticketCover.style.objectPosition = `${state.coverX}% ${state.coverY}%`;
  ticketCover.style.transform = coverTransform();
  $('.ticket-cover-blur').style.backgroundImage = `url("${state.coverUrl}")`;
  memory.style.backgroundImage = `url("${state.memoryUrl}")`;
  memory.style.backgroundSize = 'cover';
  memory.style.backgroundPosition = 'center';
  memory.querySelector('video')?.remove();
  memory.classList.toggle('has-video', Boolean(state.videoUrl));
  if (state.videoUrl) {
    const video = document.createElement('video');
    video.src = state.videoUrl;
    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) memory.style.setProperty('--play-duration', `${video.duration}s`);
    }, {once:true});
    video.addEventListener('ended', () => {
      playbackResetTimer = setTimeout(closeTicket, 280);
    });
    memory.prepend(video);
  }
  $('#ticket-city').innerHTML = cityLines(state.city);
  $('#ticket-date').textContent = state.date;
  ticketWrap.hidden = false;
  empty.hidden = true;
  resetTicket();
}

async function openTicket() {
  if (ticket.classList.contains('open') || ticket.classList.contains('tearing') || ticket.classList.contains('preparing-turn')) return;
  ticket.classList.add('preparing-turn');
  await ensurePageTurnFrames();
  ticket.classList.remove('preparing-turn');
  if (ticket.classList.contains('open') || ticket.classList.contains('tearing')) return;
  ticket.classList.add('tearing');
  startPageTurnPreview();
  createTearParticles();
  playTearSound();
  if (navigator.vibrate) navigator.vibrate([24, 28, 18, 20, 10]);
  setTimeout(() => {
    ticket.classList.remove('tearing');
    ticket.classList.add('open');
    memory.setAttribute('aria-hidden', 'false');
    const video = memory.querySelector('video');
    if (video) { video.currentTime = 0; video.play().catch(() => {}); }
    else playbackResetTimer = setTimeout(closeTicket, 7600);
  }, TICKET_TEAR_SECONDS * 1000);
}

function createTearParticles() {
  ticket.querySelectorAll('.tear-particle').forEach(piece => piece.remove());
  for (let i = 0; i < 12; i++) {
    const piece = document.createElement('i');
    piece.className = 'tear-particle';
    piece.style.setProperty('--y', `${8 + Math.random() * 84}%`);
    piece.style.setProperty('--s', `${4 + Math.random() * 7}px`);
    piece.style.setProperty('--delay', `${.18 + Math.random() * .35}s`);
    piece.style.setProperty('--drift', `${Math.random() * 30}px`);
    piece.style.setProperty('--fall', `${Math.random() * 40 - 15}px`);
    ticket.appendChild(piece);
    setTimeout(() => piece.remove(), 1300);
  }
}

function playTearSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const duration = .72;
  const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    const pulse = .45 + Math.abs(Math.sin(i * .085)) * .55;
    data[i] = (Math.random() * 2 - 1) * (1 - t) * pulse;
  }
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(900, context.currentTime);
  filter.frequency.exponentialRampToValueAtTime(4300, context.currentTime + duration);
  gain.gain.setValueAtTime(.34, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.01, context.currentTime + duration);
  source.buffer = buffer;
  source.connect(filter).connect(gain).connect(context.destination);
  source.start();
  source.onended = () => context.close();
}

function closeTicket() {
  if (!ticket.classList.contains('open')) return;
  clearTimeout(playbackResetTimer);
  memory.querySelector('video')?.pause();
  ticket.classList.add('closing');
  setTimeout(() => resetTicket(), 380);
}

function resetTicket() {
  clearTimeout(playbackResetTimer);
  ticket.classList.remove('open', 'tearing', 'closing');
  cancelAnimationFrame(pageTurnPreviewFrame);
  pageTurnCanvas.getContext('2d').clearRect(0, 0, pageTurnCanvas.width, pageTurnCanvas.height);
  $('#stub').style.opacity = '';
  memory.setAttribute('aria-hidden', 'true');
}

function ensurePageTurnFrames() {
  if (pageTurnFrames.length) return Promise.resolve(pageTurnFrames);
  if (!pageTurnFramesPromise) {
    pageTurnFramesPromise = Promise.all(Array.from({length:30}, (_, index) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `assets/page-turn/turn-${String(index).padStart(2, '0')}.png`;
    }))).then(images => (pageTurnFrames = images)).catch(error => {
      console.warn('AE page-turn frames unavailable; using the built-in fallback.', error);
      pageTurnFramesPromise = null;
      return [];
    });
  }
  return pageTurnFramesPromise;
}

function startPageTurnPreview() {
  cancelAnimationFrame(pageTurnPreviewFrame);
  ensurePageTurnFrames().then(frames => {
    if (!frames.length || !ticket.classList.contains('tearing')) return;
    const ctx = pageTurnCanvas.getContext('2d');
    const started = performance.now();
    const stubElement = $('#stub');
    function frame(now) {
      const p = Math.max(0, Math.min(1, (now - started) / (TICKET_TEAR_SECONDS * 1000)));
      const blend = smoothstep(.28, .48, p);
      ctx.clearRect(0, 0, 1080, 432);
      stubElement.style.opacity = String(1 - blend);
      if (blend > 0) {
        const pose = exportTearPose(p, 270);
        const image = frames[Math.min(frames.length - 1, Math.floor(p * frames.length))];
        drawTintedPageFrame(ctx, image, 810 + pose.x, pose.y * 1.55, 270, 432, pose.rotation, state.palette || {stub:'#496c78'}, blend);
      }
      if (p < 1 && ticket.classList.contains('tearing')) pageTurnPreviewFrame = requestAnimationFrame(frame);
    }
    pageTurnPreviewFrame = requestAnimationFrame(frame);
  });
}

function deleteTicket() {
  if (!state.custom) {
    ticketWrap.hidden = true;
    empty.hidden = false;
    return;
  }
  resetTicket();
  revokeUrls();
  state.custom = false;
  state.coverFile = null;
  state.memoryFiles = [];
  state.imageFile = state.videoFile = state.motionBlob = null;
  state.palette = null;
  resetTheme();
  memoryInput.value = '';
  videoInput.value = '';
  $('#memory-label').textContent = '选择';
  hideFramePicker();
  ticketWrap.hidden = true;
  empty.hidden = false;
  showToast('票根已删除');
}

async function exportLive() {
  if (!state.custom) return showToast('请先制作自己的票根');
  const button = $('#export-live');
  button.disabled = true;
  button.querySelector('strong').textContent = '正在生成安卓动态照片…';
  try {
    const nativeMp4 = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4');
    const [still, result] = await Promise.all([
      renderTicketStill({live:true}),
      'VideoEncoder' in window ? renderTicketMp4WithWebCodecs({live:true}) : renderTicketVideo({live:true})
    ]);
    const base = safeName(state.city) + '-ticket';
    if (result.ext !== 'mp4') throw new Error('This browser cannot encode MP4 Motion Photo');
    const motionPhoto = await makeAndroidMotionPhoto(still, result.blob);
    downloadBlob(motionPhoto, `${base}_MP.JPG`);
    closeModal(downloadMenu);
    showToast('安卓动态照片已生成，请保存后用系统相册打开');
  } catch (error) {
    console.error(error);
    showToast('当前浏览器无法编码安卓动态照片所需的 MP4');
  } finally {
    button.disabled = false;
    button.querySelector('strong').textContent = '安卓动态照片';
  }
}

async function renderTicketMp4WithWebCodecs({live = false} = {}) {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) throw new Error('WebCodecs H.264 encoding is unavailable');
  const {Output, Mp4OutputFormat, BufferTarget, CanvasSource} = await import('https://cdn.jsdelivr.net/npm/mediabunny@1.50.2/+esm');
  const canvas = document.createElement('canvas');
  const mobileExport = matchMedia('(pointer: coarse)').matches || innerWidth < 700;
  canvas.width = live ? 720 : (mobileExport ? 540 : 720);
  canvas.height = live ? 320 : (mobileExport ? 960 : 1280);
  const renderScale = canvas.width / 720;
  const cropTop = live ? LIVE_CROP_TOP : 0;
  const ctx = canvas.getContext('2d');
  const cover = await loadVisual(state.coverFile);
  const memoryImage = await loadVisual(state.imageFile || state.coverFile);
  const palette = state.palette || samplePalette(cover);
  await ensurePageTurnFrames();
  let moving = null;
  if (state.videoFile || state.motionBlob) {
    moving = document.createElement('video');
    moving.src = URL.createObjectURL(state.videoFile || state.motionBlob);
    moving.muted = true; moving.playsInline = true; moving.loop = false;
    await new Promise((resolve, reject) => { moving.onloadeddata = resolve; moving.onerror = reject; });
  }

  const target = new BufferTarget();
  const output = new Output({format:new Mp4OutputFormat(), target});
  const source = new CanvasSource(canvas, {codec:'avc', bitrate:3_000_000});
  const fps = 24;
  output.addVideoTrack(source, {frameRate:fps});
  await output.start();
  const timeline = getExportTimeline(moving);
  if (moving) { moving.pause(); moving.currentTime = 0; }
  let movingStarted = false;
  const started = performance.now();
  const totalFrames = Math.floor(timeline.total * fps);
  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const wait = started + t * 1000 - performance.now();
    if (wait > 1) await new Promise(resolve => setTimeout(resolve, wait));
    if (moving && !movingStarted && t >= timeline.contentStart) {
      moving.currentTime = 0;
      await moving.play();
      movingStarted = true;
    }
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, -cropTop * renderScale);
    drawExportFrame(ctx, t, cover, memoryImage, moving, palette, timeline);
    await source.add(t, 1 / fps);
  }
  await output.finalize();
  moving?.pause();
  if (moving) URL.revokeObjectURL(moving.src);
  if (!target.buffer) throw new Error('MP4 muxing failed');
  return {blob:new Blob([target.buffer], {type:'video/mp4'}), ext:'mp4'};
}

async function exportAppleLive() {
  if (!state.custom) return showToast('请先制作自己的票根');
  const button = $('#export-apple-live');
  button.disabled = true;
  button.querySelector('strong').textContent = '正在生成苹果实况素材…';
  try {
    const [still, result] = await Promise.all([
      renderTicketStill({live:true}),
      'VideoEncoder' in window ? renderTicketMp4WithWebCodecs({live:true}) : renderTicketVideo({live:true})
    ]);
    const base = safeName(state.city) + '-ticket';
    const files = [
      new File([still], `${base}-cover.JPG`, {type:'image/jpeg'}),
      new File([result.blob], `${base}-motion.${result.ext}`, {type:result.blob.type})
    ];
    downloadBlob(await makeZip(files), `${base}-apple-live-assets.zip`);
    closeModal(downloadMenu);
    showToast('苹果素材包已生成；需通过支持 Live Photo 的工具导入相册');
  } catch (error) {
    console.error(error);
    showToast('当前浏览器无法生成苹果实况素材');
  } finally {
    button.disabled = false;
    button.querySelector('strong').textContent = '苹果实况素材';
  }
}

async function exportVideo() {
  if (!state.custom) return showToast('请先制作自己的票根');
  const button = $('#export-video');
  button.disabled = true;
  button.querySelector('strong').textContent = '正在生成视频…';
  try {
    const result = 'VideoEncoder' in window ? await renderTicketMp4WithWebCodecs() : await renderTicketVideo();
    downloadBlob(result.blob, safeName(state.city) + '-ticket.' + result.ext);
    closeModal(downloadMenu);
    showToast('票根视频已生成');
  } catch (error) {
    console.error(error);
    showToast('当前浏览器无法生成视频，请换用 Chrome 或 Safari');
  } finally {
    button.disabled = false;
    button.querySelector('strong').textContent = '视频导出';
  }
}

async function renderTicketVideo({live = false} = {}) {
  const canvas = document.createElement('canvas');
  const mobileExport = matchMedia('(pointer: coarse)').matches || innerWidth < 700;
  canvas.width = live ? 720 : (mobileExport ? 540 : 720);
  canvas.height = live ? 320 : (mobileExport ? 960 : 1280);
  const renderScale = canvas.width / 720;
  const cropTop = live ? LIVE_CROP_TOP : 0;
  const ctx = canvas.getContext('2d');
  const cover = await loadVisual(state.coverFile);
  const memoryImage = await loadVisual(state.imageFile || state.coverFile);
  const palette = state.palette || samplePalette(cover);
  await ensurePageTurnFrames();
  let moving = null;
  if (state.videoFile || state.motionBlob) {
    moving = document.createElement('video');
    moving.src = URL.createObjectURL(state.videoFile || state.motionBlob);
    moving.muted = true; moving.playsInline = true; moving.loop = false;
    await new Promise((resolve, reject) => { moving.onloadeddata = resolve; moving.onerror = reject; });
    moving.pause();
    moving.currentTime = 0;
  }
  const timeline = getExportTimeline(moving);
  const mime = ['video/mp4','video/webm;codecs=vp9','video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('MediaRecorder unsupported');
  const recorder = new MediaRecorder(canvas.captureStream(mobileExport ? 24 : 30), { mimeType: mime, videoBitsPerSecond: mobileExport ? 3_000_000 : 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
  const done = new Promise(resolve => recorder.onstop = resolve);
  const start = performance.now();
  let movingStarted = false;
  recorder.start(200);

  await new Promise(resolve => {
    function frame(now) {
      const elapsed = (now - start) / 1000;
      if (moving && !movingStarted && elapsed >= timeline.contentStart) {
        moving.currentTime = 0;
        moving.play().catch(() => {});
        movingStarted = true;
      }
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, -cropTop * renderScale);
      drawExportFrame(ctx, elapsed, cover, memoryImage, moving, palette, timeline);
      if (elapsed < timeline.total) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
  recorder.stop();
  await done;
  moving?.pause();
  if (moving) URL.revokeObjectURL(moving.src);
  return { blob: new Blob(chunks, { type: mime }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

async function renderTicketStill({live = false} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = live ? 320 : 1280;
  const cover = await loadVisual(state.coverFile);
  if (live) canvas.getContext('2d').setTransform(1, 0, 0, 1, 0, -LIVE_CROP_TOP);
  drawExportFrame(canvas.getContext('2d'), 0, cover, cover, null, state.palette || samplePalette(cover));
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Still export failed')), 'image/jpeg', .94));
}

async function makeAndroidMotionPhoto(stillBlob, videoBlob) {
  const videoLength = videoBlob.size;
  const xmp = `http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Travel Stub"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Camera="http://ns.google.com/photos/1.0/camera/" xmlns:GContainer="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" Camera:MotionPhoto="1" Camera:MotionPhotoVersion="1" Camera:MotionPhotoPresentationTimestampUs="-1"><GContainer:Directory><rdf:Seq><rdf:li rdf:parseType="Resource" Item:Mime="image/jpeg" Item:Semantic="Primary"/><rdf:li rdf:parseType="Resource" Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLength}"/></rdf:Seq></GContainer:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const xmpBytes = new TextEncoder().encode(xmp);
  if (xmpBytes.length + 2 > 65535) throw new Error('XMP metadata is too large');
  const app1 = new Uint8Array(4 + xmpBytes.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  new DataView(app1.buffer).setUint16(2, xmpBytes.length + 2, false);
  app1.set(xmpBytes, 4);
  const jpeg = new Uint8Array(await stillBlob.arrayBuffer());
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Invalid JPEG still image');
  return new Blob([jpeg.subarray(0, 2), app1, jpeg.subarray(2), videoBlob], {type:'image/jpeg'});
}

function getExportTimeline(moving) {
  const mediaDuration = moving && Number.isFinite(moving.duration) && moving.duration > 0
    ? moving.duration
    : PHOTO_PLAY_SECONDS;
  const contentStart = TICKET_TEAR_SECONDS;
  const resetAt = contentStart + mediaDuration;
  return {tearStart:0, tearDuration:TICKET_TEAR_SECONDS, contentStart, mediaDuration, resetAt, total:resetAt + TICKET_OUTRO_SECONDS};
}

function drawExportFrame(ctx, t, cover, memoryImage, moving, palette, suppliedTimeline = null) {
  const W = 720, H = 1280, x = 54, y = EXPORT_TICKET_Y, w = 612, h = 245, stubW = 154;
  const timeline = suppliedTimeline || getExportTimeline(moving);
  const {tearStart, tearDuration, contentStart, resetAt} = timeline;
  const intact = t < tearStart || t >= resetAt;
  const tearLinear = Math.max(0, Math.min(1, (t - tearStart) / tearDuration));
  const stubPose = exportTearPose(tearLinear, stubW);
  const revealProgress = easeOutCubic(Math.max(0, Math.min(1, (t - contentStart) / .45)));
  ctx.fillStyle = palette.background; ctx.fillRect(0, 0, W, H);
  if (!intact && t < contentStart + .45) {
    ctx.save();
    ctx.globalAlpha = .14 * Math.sin(tearLinear * Math.PI);
    ctx.fillStyle = '#000';
    roundedPath(ctx, x + 4, y + 10, w, h, 13);
    ctx.fill();
    ctx.restore();
  }
  ctx.save(); roundedPath(ctx, x, y, w, h, 13); ctx.clip();
  if (intact || t < contentStart + .45) {
    drawCrop(ctx, cover, x, y, w - stubW, h, 1);
  }
  if (!intact && t >= contentStart) {
    ctx.globalAlpha = revealProgress;
    drawCrop(ctx, moving && moving.readyState >= 2 ? moving : memoryImage, x, y, w, h, 1);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (intact) drawExportStub(ctx, x + w - stubW, y, stubW, h, 0, palette);
  else if (t < contentStart + .45) {
    drawExportTear(ctx, x + w - stubW, y, h, tearLinear, palette);
    const pageTurnBlend = pageTurnFrames.length ? smoothstep(.28, .48, tearLinear) : 0;
    if (pageTurnBlend < 1) {
      ctx.save(); ctx.globalAlpha = 1 - pageTurnBlend;
      drawExportStub(ctx, x + w - stubW + stubPose.x, y + stubPose.y, stubW, h, stubPose.rotation, palette, {
        torn: tearLinear > .18,
        tearProgress: tearLinear,
        shadow: .28 + stubPose.release * .48,
        bend: Math.sin(Math.min(1, tearLinear) * Math.PI) * 9
      });
      ctx.restore();
    }
    if (pageTurnBlend > 0) {
      const image = pageTurnFrames[Math.min(pageTurnFrames.length - 1, Math.floor(tearLinear * pageTurnFrames.length))];
      drawTintedPageFrame(ctx, image, x + w - stubW + stubPose.x, y + stubPose.y, stubW, h, stubPose.rotation, palette, pageTurnBlend);
    }
    drawExportRipFlash(ctx, x + w - stubW, y, h, tearLinear);
  } else if (t < resetAt) {
    drawExportTornEdge(ctx, x + w - stubW, y, h, .18);
  }
}

function exportTearPose(p, stubW) {
  const release = easeOutCubic(Math.max(0, (p - .42) / .58));
  const cssLike = [
    {p:0, x:0, y:0, r:0},
    {p:.14, x:-5, y:0, r:-1},
    {p:.28, x:8, y:-3, r:1},
    {p:.43, x:-2, y:3, r:-1.5},
    {p:.58, x:23, y:-2, r:3},
    {p:.72, x:52, y:9, r:6},
    {p:1, x:stubW * 1.45, y:69, r:19}
  ];
  let a = cssLike[0], b = cssLike[cssLike.length - 1];
  for (let i = 0; i < cssLike.length - 1; i++) {
    if (p >= cssLike[i].p && p <= cssLike[i + 1].p) {
      a = cssLike[i]; b = cssLike[i + 1]; break;
    }
  }
  const local = a === b ? 1 : easeInOutCubic((p - a.p) / Math.max(.001, b.p - a.p));
  return {
    x: lerp(a.x, b.x, local) + (1 - release) * Math.sin(p * 78) * 8,
    y: lerp(a.y, b.y, local),
    rotation: lerp(a.r, b.r, local) * Math.PI / 180,
    release
  };
}

function drawJaggedStubPath(ctx, w, h, bend = 0, tearProgress = 1) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let py = 0; py <= h; py += 11) {
    const tornHere = py <= h * Math.min(1, tearProgress);
    const bite = tornHere ? (Math.floor(py / 11) % 2 ? 8 : -3) + Math.sin(py * .09) * 2 : 0;
    ctx.lineTo(bite + Math.sin((py / h) * Math.PI) * bend, py);
  }
  ctx.lineTo(w, h);
  ctx.lineTo(w, 0);
  ctx.closePath();
}

function drawExportStub(ctx, x, y, w, h, rotation, palette, options = {}) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation);
  if (options.shadow) {
    ctx.save();
    ctx.globalAlpha = options.shadow;
    ctx.fillStyle = 'rgba(0,0,0,.36)';
    ctx.filter = 'blur(10px)';
    ctx.translate(-14, 17);
    if (options.torn) drawJaggedStubPath(ctx, w, h, options.bend || 0, options.tearProgress); else ctx.rect(0, 0, w, h);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = palette.stub;
  if (options.torn) {
    drawJaggedStubPath(ctx, w, h, options.bend || 0, options.tearProgress);
    ctx.fill();
    ctx.save();
    ctx.globalAlpha = .44;
    ctx.strokeStyle = 'rgba(255,255,255,.58)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let py = 4; py <= h - 4; py += 12) {
      const tornHere = py <= h * Math.min(1, options.tearProgress ?? 1);
      const px = tornHere ? (Math.floor(py / 12) % 2 ? 6 : -3) + Math.sin(py * .09) * 2 + Math.sin((py / h) * Math.PI) * (options.bend || 0) : 0;
      if (py === 4) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = palette.notch; ctx.beginPath(); ctx.arc(w, h / 2, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7f4e9'; ctx.font = 'bold 31px Arial';
  cityLines(state.city).split('<br>').forEach((line, i) => ctx.fillText(line, 19, 52 + i * 31));
  ctx.font = 'bold 17px Arial'; ctx.fillText(state.date, 19, 151);
  ctx.globalAlpha = .75; ctx.font = 'bold 10px Arial'; ctx.fillText('NO.848620', 19, 186); ctx.fillText('TRAVELSTUB', 19, 206);
  for (let i = 0; i < 9; i++) ctx.fillRect(20 + i * 11, 218, i % 3 === 0 ? 5 : 3, 19);
  ctx.restore();
}

function drawExportTear(ctx, seamX, y, h, progress, palette) {
  if (progress <= 0 || progress >= .96) return;
  ctx.save();
  ctx.save();
  ctx.globalAlpha = .12 + .24 * Math.sin(progress * Math.PI);
  ctx.fillStyle = '#000';
  ctx.fillRect(seamX - 5, y, 14 + progress * 14, h);
  ctx.restore();
  ctx.strokeStyle = 'rgba(247,241,226,.97)'; ctx.lineWidth = 5;
  ctx.beginPath();
  const visible = h * Math.min(1, progress);
  for (let py = 0; py <= visible; py += 7) {
    const px = seamX + (Math.floor(py / 7) % 2 ? 7 : -5) + Math.sin(py * .12 + progress * 7) * 2;
    if (py === 0) ctx.moveTo(px, y + py); else ctx.lineTo(px, y + py);
  }
  ctx.stroke();
  const release = easeOutCubic(Math.max(0, (progress - .15) / .85));
  ctx.fillStyle = 'rgba(238,229,210,.98)';
  for (let i = 0; i < 18; i++) {
    const phase = (i * .31 + release) % 1;
    const px = seamX + 4 + release * (34 + i * 5);
    const py = y + 10 + i * 13 + Math.sin(phase * 11) * 13;
    ctx.save(); ctx.translate(px, py); ctx.rotate(release * 5.6 + i * .7); ctx.fillRect(-4, -2, 10, 4); ctx.restore();
  }
  ctx.restore();
}

function drawExportRipFlash(ctx, seamX, y, h, progress) {
  if (progress < .06 || progress > .92) return;
  const head = y + Math.min(h, h * progress);
  ctx.save();
  ctx.globalAlpha = Math.sin(progress * Math.PI) * .42;
  ctx.strokeStyle = 'rgba(255,255,255,.88)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    const yy = head - i * 13;
    if (yy < y || yy > y + h) continue;
    ctx.beginPath();
    ctx.moveTo(seamX + 8, yy);
    ctx.lineTo(seamX + 28 + i * 3, yy - 6 + Math.sin(i) * 5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawExportTornEdge(ctx, seamX, y, h, alpha = .2) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(247,241,226,.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let py = 0; py <= h; py += 9) {
    const px = seamX + (Math.floor(py / 9) % 2 ? 4 : -4);
    if (py === 0) ctx.moveTo(px, y + py); else ctx.lineTo(px, y + py);
  }
  ctx.stroke();
  ctx.restore();
}

function drawTintedPageFrame(ctx, image, x, y, w, h, rotation, palette, alpha = 1) {
  if (!image) return;
  const surface = document.createElement('canvas');
  surface.width = image.naturalWidth || image.width;
  surface.height = image.naturalHeight || image.height;
  const surfaceContext = surface.getContext('2d');
  surfaceContext.drawImage(image, 0, 0);
  surfaceContext.globalCompositeOperation = 'source-atop';
  surfaceContext.globalAlpha = .82;
  surfaceContext.fillStyle = palette.stub;
  surfaceContext.fillRect(0, 0, surface.width, surface.height);
  surfaceContext.globalCompositeOperation = 'source-over';
  surfaceContext.globalAlpha = 1;

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.drawImage(surface, 0, 0, w, h);
  ctx.restore();
}

function lerp(a, b, p) { return a + (b - a) * p; }
function smoothstep(start, end, value) {
  const p = Math.max(0, Math.min(1, (value - start) / Math.max(.0001, end - start)));
  return p * p * (3 - 2 * p);
}
function easeInOutCubic(v) { return v < .5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; }
function easeOutCubic(v) { return 1 - Math.pow(1 - v, 3); }

function samplePalette(source) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 32;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  drawCrop(ctx, source, 0, 0, 64, 32, 1);
  const pixels = ctx.getImageData(46, 0, 18, 32).data;
  let r=0,g=0,b=0,weightSum=0;
  for(let i=0;i<pixels.length;i+=4){
    if(pixels[i+3]<128)continue;
    const max=Math.max(pixels[i],pixels[i+1],pixels[i+2]);
    const min=Math.min(pixels[i],pixels[i+1],pixels[i+2]);
    const saturation=(max-min)/Math.max(1,max);
    const weight=.45+saturation*1.8;
    r+=pixels[i]*weight;g+=pixels[i+1]*weight;b+=pixels[i+2]*weight;weightSum+=weight;
  }
  const color=[r/weightSum||50,g/weightSum||70,b/weightSum||65];
  return {background:tone(color,42),stub:tone(color,105),notch:tone(color,65)};
}

function applyTheme(palette) {
  const root = document.documentElement.style;
  root.setProperty('--bg', palette.background);
  root.setProperty('--stub', palette.stub);
  root.setProperty('--stub-dark', palette.notch);
}

function resetTheme() {
  const root = document.documentElement.style;
  root.removeProperty('--bg');
  root.removeProperty('--stub');
  root.removeProperty('--stub-dark');
}

function tone(rgb, target) {
  const light=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]||1;
  const scale=target/light;
  const values=rgb.map(value=>Math.max(0,Math.min(255,Math.round(value*scale))));
  return `rgb(${values.join(',')})`;
}

function drawCrop(ctx, source, x, y, w, h, zoom = 1) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.max(w / sw, h / sh) * zoom;
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

async function loadVisual(file) {
  try { return await createImageBitmap(file); }
  catch {
    const image = new Image(); image.src = URL.createObjectURL(file);
    await image.decode(); return image;
  }
}

async function prepareFramePicker(videoFile, fallbackImage, timeout = 15000) {
  const video = $('#cover-frame-video');
  if (fallbackImage) await setDraftCover(fallbackImage, true);
  if (state.frameVideoUrl) URL.revokeObjectURL(state.frameVideoUrl);
  state.frameVideoUrl = URL.createObjectURL(videoFile);
  video.src = state.frameVideoUrl;
  video.hidden = false;
  $('#frame-picker').hidden = false;
  video.load();
  await waitForMedia(video, 'loadedmetadata', timeout);
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Invalid video duration');
  const initialTime = Math.min(.5, video.duration * .15);
  $('#frame-range').value = String(Math.round((initialTime / video.duration) * 1000));
  $('#frame-time').textContent = formatTime(initialTime);
  video.currentTime = initialTime;
  await waitForMedia(video, 'seeked', timeout);
  const frame = await captureFrameElement(video);
  state.coverFile = frame;
  await setDraftCover(frame, true);
}

function waitForMedia(media, event, timeout) {
  if (event === 'loadedmetadata' && media.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeout);
    const done = () => { clearTimeout(timer); media.removeEventListener('error', failed); resolve(); };
    const failed = () => { clearTimeout(timer); media.removeEventListener(event, done); reject(new Error('Video format is not supported')); };
    media.addEventListener(event, done, {once:true});
    media.addEventListener('error', failed, {once:true});
  });
}

async function captureFrameElement(video) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Video frame unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .94));
  if (!blob) throw new Error('Frame capture failed');
  return new File([blob], 'selected-live-cover.jpg', {type:'image/jpeg'});
}

async function setDraftCover(file, keepVideo = false) {
  if (!file) return;
  if (state.draftCoverUrl) URL.revokeObjectURL(state.draftCoverUrl);
  state.draftCoverUrl = URL.createObjectURL(file);
  $('#cover-preview-image').src = state.draftCoverUrl;
  $('.preview-blur').style.backgroundImage = `url("${state.draftCoverUrl}")`;
  if (!keepVideo) $('#cover-frame-video').hidden = true;
}

function hideFramePicker() {
  const video = $('#cover-frame-video');
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  $('#frame-picker').hidden = true;
  if (state.frameVideoUrl) URL.revokeObjectURL(state.frameVideoUrl);
  state.frameVideoUrl = null;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

async function captureVideoFrame(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url; video.muted = true; video.playsInline = true;
  await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
  if (video.duration > .25) {
    video.currentTime = Math.min(.5, video.duration / 3);
    await new Promise(resolve => video.onseeked = resolve);
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
  URL.revokeObjectURL(url);
  if (!blob) throw new Error('Frame capture failed');
  return new File([blob], 'video-cover.jpg', {type:'image/jpeg'});
}

async function extractAndroidMotionVideo(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));
    const item = head.match(/<[^>]+(?:Semantic|Item:Semantic)=["']MotionPhoto["'][^>]*>/i)?.[0] || head.match(/<[^>]+(?:Mime|Item:Mime)=["']video\/(?:mp4|quicktime)["'][^>]*>/i)?.[0];
    const match = item?.match(/(?:Length|Item:Length)=["'](\d+)["']/i);
    if (match) {
      const length = Number(match[1]);
      if (length > 8 && length < bytes.length) return new Blob([bytes.subarray(bytes.length - length)], {type:'video/mp4'});
    }
    for (let i = bytes.length - 4; i >= 4; i--) {
      if (bytes[i]===0x6d&&bytes[i+1]===0x70&&bytes[i+2]===0x76&&bytes[i+3]===0x64) {
        const start=i-4,size=readU32(bytes,start);
        if(size>=8&&start+size<=bytes.length)return new Blob([bytes.subarray(i+4,start+size)],{type:'video/mp4'});
      }
    }
    for (let i=bytes.length-4;i>=Math.max(4,bytes.length-30*1024*1024);i--) {
      if(bytes[i]===0x66&&bytes[i+1]===0x74&&bytes[i+2]===0x79&&bytes[i+3]===0x70){const start=i-4,size=readU32(bytes,start);if(size>=8&&size<bytes.length-start)return new Blob([bytes.subarray(start)],{type:'video/mp4'});}
    }
  } catch (error) { console.warn('Motion Photo parse failed', error); }
  return null;
}

async function makeZip(files) {
  const entries = [];
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    entries.push({name,data,crc:crc32(data),offset:0});
  }
  const parts=[]; let offset=0;
  for(const e of entries){e.offset=offset;const h=new Uint8Array(30+e.name.length);const v=new DataView(h.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,e.crc,true);v.setUint32(18,e.data.length,true);v.setUint32(22,e.data.length,true);v.setUint16(26,e.name.length,true);h.set(e.name,30);parts.push(h,e.data);offset+=h.length+e.data.length;}
  const centralStart=offset;
  for(const e of entries){const h=new Uint8Array(46+e.name.length);const v=new DataView(h.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(16,e.crc,true);v.setUint32(20,e.data.length,true);v.setUint32(24,e.data.length,true);v.setUint16(28,e.name.length,true);v.setUint32(42,e.offset,true);h.set(e.name,46);parts.push(h);offset+=h.length;}
  const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,offset-centralStart,true);v.setUint32(16,centralStart,true);parts.push(end);
  return new Blob(parts,{type:'application/zip'});
}

const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function readU32(b,o){return((b[o]*0x1000000)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3])>>>0;}
function isImage(f){return f.type.startsWith('image/')||/\.(jpe?g|png|heic|heif|avif|webp)$/i.test(f.name);}
function isVideo(f){return f.type.startsWith('video/')||/\.(mov|mp4|m4v|webm)$/i.test(f.name);}
function cityLines(city){const s=city.replace(/\s+/g,'');const cut=Math.ceil(s.length/2);return `${s.slice(0,cut)}<br>${s.slice(cut)}`;}
function shortName(name){return name.length>13?name.slice(0,10)+'…':name;}
function safeName(name){return(name||'travel').replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi,'-');}
function extension(name,fallback){return name.includes('.')?name.split('.').pop():fallback;}
function openModal(el){el.hidden=false;document.body.style.overflow='hidden';}
function closeModal(el){el.hidden=true;document.body.style.overflow='';}
function showToast(message){toast.textContent=message;toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),2800);}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);}
function revokeUrls(){['coverUrl','memoryUrl','videoUrl','draftCoverUrl','frameVideoUrl'].forEach(key=>{if(state[key])URL.revokeObjectURL(state[key]);state[key]=null;});}
