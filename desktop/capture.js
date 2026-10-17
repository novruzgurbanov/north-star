const video = document.getElementById('camera');
const canvas = document.getElementById('frame');
let stream = null;
let opening = null;
let revision = 0;

function stopCamera() {
  revision += 1;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  opening = null;
  video.srcObject = null;
  canvas.getContext('2d').clearRect(0, 0, 640, 360);
}

async function openCamera() {
  if (stream?.getVideoTracks().some((track) => track.readyState === 'live')) return true;
  if (opening) return opening;
  const current = ++revision;
  const operation = (async () => {
    let candidate;
    try {
      candidate = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false,
      });
      if (current !== revision) {
        candidate.getTracks().forEach((track) => track.stop());
        return false;
      }
      stream = candidate;
      video.srcObject = stream;
      await video.play();
      return current === revision;
    } catch {
      candidate?.getTracks().forEach((track) => track.stop());
      if (current === revision) stopCamera();
      return false;
    } finally {
      if (current === revision) opening = null;
    }
  })();
  opening = operation;
  return operation;
}

window.northStarCapture.onCommand(async (command) => {
  if (!command || typeof command.id !== 'string' || command.id.length > 100) return;
  const { id, action } = command;
  if (action === 'disable') {
    stopCamera();
    window.northStarCapture.reply({ id, active: false });
  } else if (action === 'enable') {
    window.northStarCapture.reply({ id, active: await openCamera() });
  } else if (action === 'frame') {
    try {
      if (!await openCamera()) throw new Error('Camera unavailable');
      if (video.readyState < 2 || !video.videoWidth) throw new Error('Camera warming up');
      canvas.getContext('2d').drawImage(video, 0, 0, 640, 360);
      const frame = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
      window.northStarCapture.reply({ id, active: true, frame });
    } catch {
      window.northStarCapture.reply({ id, active: false });
    } finally {
      canvas.getContext('2d').clearRect(0, 0, 640, 360);
    }
  }
});

window.addEventListener('beforeunload', stopCamera);
