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
let playbackResetTimer = null;

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
$('#export-video').addEventListener('click', exportVideo);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal($('#' + button.dataset.close))));

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
    if (movingSource) await prepareFramePicker(movingSource, imageFile);
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
    $('#memory-label').textContent = '重新选择';
    showToast('无法读取该素材的定格画面，请换一个文件');
  }
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

function openTicket() {
  if (ticket.classList.contains('open') || ticket.classList.contains('tearing')) return;
  ticket.classList.add('tearing');
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
  }, 760);
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
  memory.setAttribute('aria-hidden', 'true');
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
  button.querySelector('strong').textContent = '正在生成实况包…';
  try {
    const [still, result] = await Promise.all([renderTicketStill(), renderTicketVideo()]);
    const base = safeName(state.city) + '-ticket';
    const files = [
      new File([still], `${base}-cover.jpg`, {type:'image/jpeg'}),
      new File([result.blob], `${base}-motion.${result.ext}`, {type:result.blob.type})
    ];
    const bundle = await makeZip(files);
    downloadBlob(bundle, `${base}-live-package.zip`);
    closeModal(downloadMenu);
    showToast('票根定格图和动态文件已打包');
  } catch (error) {
    console.error(error);
    showToast('当前浏览器无法生成实况包');
  } finally {
    button.disabled = false;
    button.querySelector('strong').textContent = '实况导出';
  }
}

async function exportVideo() {
  if (!state.custom) return showToast('请先制作自己的票根');
  const button = $('#export-video');
  button.disabled = true;
  button.querySelector('strong').textContent = '正在生成视频…';
  try {
    const result = await renderTicketVideo();
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

async function renderTicketVideo() {
  const canvas = document.createElement('canvas');
  const mobileExport = matchMedia('(pointer: coarse)').matches || innerWidth < 700;
  canvas.width = mobileExport ? 540 : 720;
  canvas.height = mobileExport ? 960 : 1280;
  const renderScale = canvas.width / 720;
  const ctx = canvas.getContext('2d');
  const cover = await loadVisual(state.coverFile);
  const memoryImage = await loadVisual(state.imageFile || state.coverFile);
  const palette = state.palette || samplePalette(cover);
  let moving = null;
  if (state.videoFile || state.motionBlob) {
    moving = document.createElement('video');
    moving.src = URL.createObjectURL(state.videoFile || state.motionBlob);
    moving.muted = true; moving.playsInline = true; moving.loop = false;
    await new Promise((resolve, reject) => { moving.onloadeddata = resolve; moving.onerror = reject; });
    await moving.play();
  }
  const mime = ['video/mp4','video/webm;codecs=vp9','video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('MediaRecorder unsupported');
  const recorder = new MediaRecorder(canvas.captureStream(mobileExport ? 24 : 30), { mimeType: mime, videoBitsPerSecond: mobileExport ? 3_000_000 : 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
  const done = new Promise(resolve => recorder.onstop = resolve);
  const start = performance.now();
  recorder.start(200);

  await new Promise(resolve => {
    function frame(now) {
      const elapsed = (now - start) / 1000;
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      drawExportFrame(ctx, elapsed, cover, memoryImage, moving, palette);
      if (elapsed < 5.6) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
  recorder.stop();
  await done;
  moving?.pause();
  if (moving) URL.revokeObjectURL(moving.src);
  return { blob: new Blob(chunks, { type: mime }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

async function renderTicketStill() {
  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = 1280;
  const cover = await loadVisual(state.coverFile);
  drawExportFrame(canvas.getContext('2d'), 0, cover, cover, null, state.palette || samplePalette(cover));
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Still export failed')), 'image/jpeg', .94));
}

function drawExportFrame(ctx, t, cover, memoryImage, moving, palette) {
  const W = 720, H = 1280, x = 54, y = 460, w = 612, h = 245, stubW = 154;
  const intact = t < 1.05 || t >= 4.7;
  const tearProgress = Math.max(0, Math.min(1, (t - 1.05) / 1.15));
  const revealProgress = Math.max(0, Math.min(1, (t - 2.12) / .48));
  ctx.fillStyle = palette.background; ctx.fillRect(0, 0, W, H);
  ctx.save(); roundedPath(ctx, x, y, w, h, 13); ctx.clip();
  if (intact || t < 2.6) {
    drawCrop(ctx, cover, x, y, w - stubW, h, 1);
  }
  if (!intact && t >= 2.12) {
    ctx.globalAlpha = revealProgress;
    drawCrop(ctx, moving && moving.readyState >= 2 ? moving : memoryImage, x, y, w, h, 1);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (intact) drawExportStub(ctx, x + w - stubW, y, stubW, h, 0, palette);
  else if (t < 2.35) {
    const resistance = tearProgress < .3 ? Math.sin(tearProgress * 46) * 7 : 0;
    const release = Math.max(0, (tearProgress - .28) / .72);
    const sx = x + w - stubW + resistance + release * (stubW + 105);
    drawExportStub(ctx, sx, y + Math.sin(release * Math.PI) * 12 + release * 24, stubW, h, release * .28, palette);
    drawExportTear(ctx, x + w - stubW, y, h, tearProgress, palette);
  }
}

function drawExportStub(ctx, x, y, w, h, rotation, palette) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation);
  ctx.fillStyle = palette.stub; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = palette.notch; ctx.beginPath(); ctx.arc(w, h / 2, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7f4e9'; ctx.font = 'bold 31px Arial';
  cityLines(state.city).split('<br>').forEach((line, i) => ctx.fillText(line, 19, 52 + i * 31));
  ctx.font = 'bold 17px Arial'; ctx.fillText(state.date, 19, 151);
  ctx.globalAlpha = .75; ctx.font = 'bold 10px Arial'; ctx.fillText('NO.848620', 19, 186); ctx.fillText('TRAVELSTUB', 19, 206);
  for (let i = 0; i < 9; i++) ctx.fillRect(20 + i * 11, 218, i % 3 === 0 ? 5 : 3, 19);
  ctx.restore();
}

function drawExportTear(ctx, seamX, y, h, progress, palette) {
  if (progress <= 0 || progress >= .98) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(247,241,226,.95)'; ctx.lineWidth = 3;
  ctx.beginPath();
  const visible = h * Math.min(1, progress * 1.7);
  for (let py = 0; py <= visible; py += 8) {
    const px = seamX + (Math.floor(py / 8) % 2 ? 4 : -3);
    if (py === 0) ctx.moveTo(px, y + py); else ctx.lineTo(px, y + py);
  }
  ctx.stroke();
  const release = Math.max(0, (progress - .2) / .8);
  ctx.fillStyle = 'rgba(238,229,210,.95)';
  for (let i = 0; i < 9; i++) {
    const phase = (i * .37 + release) % 1;
    const px = seamX + 5 + release * (22 + i * 4);
    const py = y + 18 + i * 23 + Math.sin(phase * 9) * 9;
    ctx.save(); ctx.translate(px, py); ctx.rotate(release * 4 + i); ctx.fillRect(-3, -2, 7, 4); ctx.restore();
  }
  ctx.restore();
}

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

async function prepareFramePicker(videoFile, fallbackImage) {
  const video = $('#cover-frame-video');
  if (fallbackImage) await setDraftCover(fallbackImage, true);
  if (state.frameVideoUrl) URL.revokeObjectURL(state.frameVideoUrl);
  state.frameVideoUrl = URL.createObjectURL(videoFile);
  video.src = state.frameVideoUrl;
  video.hidden = false;
  $('#frame-picker').hidden = false;
  video.load();
  await waitForMedia(video, 'loadedmetadata', 15000);
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Invalid video duration');
  const initialTime = Math.min(.5, video.duration * .15);
  $('#frame-range').value = String(Math.round((initialTime / video.duration) * 1000));
  $('#frame-time').textContent = formatTime(initialTime);
  video.currentTime = initialTime;
  await waitForMedia(video, 'seeked', 15000);
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
