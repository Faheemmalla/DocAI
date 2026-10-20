const $ = id => document.getElementById(id);

const TOKEN_KEY = 'docai_token';

let history = [],
    imageData = null,
    recorder = null,
    audioChunks = [],
    cameraStream = null,
    lastAnswer = '';

/* ---------- UI helpers (cosmetic only) ---------- */
const setMic = text => {
    const s = $('mic').querySelector('span');
    if (s) s.textContent = text;
};

const autosize = () => {
    const t = $('message');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
};

/* restore saved token */
try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) $('token').value = saved;
} catch { }

/* ---------- original logic ---------- */
const headers = () => {
    const h = {};
    const token = $('token').value.trim();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
};

function bubble(text, kind = 'bot', sources = []) {
    const el = document.createElement('article');
    el.className = kind;
    el.textContent = text;

    if (sources.length) {
        const s = document.createElement('div');
        s.className = 'sources';
        s.textContent = 'Sources: ' + sources
            .slice(0, 8)
            .map(x => x.type === 'pdf' ? `PDF page ${x.page}` : x.url)
            .join(' | ');
        el.appendChild(s);
    }

    $('messages').appendChild(el);
    $('messages').scrollTop = $('messages').scrollHeight;
    return el;
}

async function check() {
    try {
        const r = await fetch('/api/health');
        const d = await r.json();
        $('status').textContent = d.configured ? '● Connected' : '⚠ Configure API keys';
        $('status').dataset.state = d.configured ? 'ok' : 'warn';
    } catch {
        $('status').textContent = '● Server offline';
        $('status').dataset.state = 'off';
    }
}
check();

/* ---------- token connect ---------- */
$('connect').onclick = () => {
    const t = $('token').value.trim();
    try {
        if (t) localStorage.setItem(TOKEN_KEY, t);
        else localStorage.removeItem(TOKEN_KEY);
    } catch { }

    $('tokenbar').classList.remove('invalid');
    check();

    const label = $('connect').querySelector('span');
    label.textContent = t ? 'Saved ✓' : 'Cleared';
    $('connect').classList.add('done');
    setTimeout(() => {
        label.textContent = 'Connect';
        $('connect').classList.remove('done');
    }, 1600);
};

$('token').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        $('connect').click();
    }
});

$('toggleToken').onclick = () => {
    const show = $('token').type === 'password';
    $('token').type = show ? 'text' : 'password';
    $('toggleToken').classList.toggle('shown', show);
    $('toggleToken').setAttribute('aria-label', show ? 'Hide token' : 'Show token');
};

function markTokenInvalid() {
    const bar = $('tokenbar');
    bar.classList.remove('invalid');
    void bar.offsetWidth;
    bar.classList.add('invalid');
    $('status').textContent = '⚠ Invalid token';
    $('status').dataset.state = 'warn';
    $('token').focus();
}

/* ---------- new chat ---------- */
$('newChat').onclick = () => {
    history = [];
    lastAnswer = '';
    $('messages').querySelectorAll('article').forEach(a => a.remove());
    $('messages').classList.remove('started');
    $('remove').click();
    $('message').value = '';
    autosize();
    $('message').focus();
};

/* ---------- suggestion chips ---------- */
document.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
        $('message').value = chip.dataset.q;
        autosize();
        $('chatForm').requestSubmit();
    };
});

/* ---------- image ---------- */
function setImage(file) {
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5e6) {
        alert('Use PNG/JPEG/WebP under 5MB');
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        imageData = reader.result;
        $('thumbnail').src = imageData;
        $('preview').hidden = false;
    };
    reader.readAsDataURL(file);
}

$('image').addEventListener('change', e => setImage(e.target.files[0]));

$('remove').onclick = () => {
    imageData = null;
    $('preview').hidden = true;
    $('image').value = '';
};

/* ---------- chat ---------- */
/* Enter = send, Shift+Enter = new line */
$('message').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if ($('send').disabled) return;
        $('chatForm').requestSubmit();
    }
});
$('message').addEventListener('input', autosize);

$('chatForm').addEventListener('submit', async e => {
    e.preventDefault();

    const message = $('message').value.trim();
    if (!message) return;

    const prior = history.slice(-8);
    $('messages').classList.add('started');
    bubble(message, 'user');
    $('message').value = '';
    autosize();
    $('send').disabled = true;
    const pending = bubble('Thinking…');
    pending.classList.add('thinking');
    let authFailed = false;

    try {
        const r = await fetch('/api/chat', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, history: prior, image_data: imageData })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Request failed');

        pending.textContent = d.answer;
        lastAnswer = d.answer;

        if (d.sources?.length) {
            const src = document.createElement('div');
            src.className = 'sources';
            src.textContent = 'Sources: ' + d.sources
                .slice(0, 8)
                .map(x => x.type === 'pdf' ? `PDF page ${x.page}` : x.url)
                .join(' | ');
            pending.appendChild(src);
        }

        history.push(
            { role: 'user', content: message },
            { role: 'assistant', content: d.answer }
        );
        $('remove').click();

        if ($('tokenbar').classList.contains('invalid')) {
            $('tokenbar').classList.remove('invalid');
            check();
        }
    } catch (err) {
        pending.textContent = 'Error: ' + err.message;
        if (/invalid.*token|token.*(invalid|missing|required)|unauthori[sz]ed|forbidden/i.test(err.message)) {
            authFailed = true;
            markTokenInvalid();
        }
    } finally {
        pending.classList.remove('thinking');
        $('send').disabled = false;
        $('messages').scrollTop = $('messages').scrollHeight;
        if (!authFailed) $('message').focus();
    }
});

/* ---------- voice ---------- */
$('mic').onclick = async () => {
    if (recorder && recorder.state === 'recording') {
        recorder.stop();
        $('mic').classList.remove('recording');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        recorder = new MediaRecorder(stream);

        recorder.ondataavailable = e => audioChunks.push(e.data);

        recorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());

            const blob = new Blob(audioChunks, { type: recorder.mimeType });
            const data = new FormData();
            data.append('file', blob, 'voice.webm');
            $('mic').disabled = true;
            setMic('Transcribing…');

            try {
                const r = await fetch('/api/transcribe', {
                    method: 'POST',
                    headers: headers(),
                    body: data
                });
                const out = await r.json();
                if (!r.ok) throw Error(out.detail);
                $('message').value = out.text;
                autosize();
                $('message').focus();
            } catch (e) {
                alert(e.message);
            } finally {
                $('mic').disabled = false;
                setMic('Voice');
            }
        };

        recorder.start();
        $('mic').classList.add('recording');
        setMic('Stop recording');
    } catch (e) {
        $('mic').classList.remove('recording');
        setMic('Voice');
        alert('Microphone unavailable: ' + e.message);
    }
};

/* ---------- read aloud ---------- */
$('listen').onclick = async () => {
    if (!lastAnswer) return alert('Ask a question first');

    $('listen').disabled = true;
    try {
        const r = await fetch('/api/speak', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: lastAnswer })
        });
        if (!r.ok) throw Error('Speech unavailable');

        const url = URL.createObjectURL(await r.blob());
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
    } catch (e) {
        alert(e.message);
    } finally {
        $('listen').disabled = false;
    }
};

/* ---------- camera ---------- */
$('camera').onclick = async () => {
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });
        $('video').srcObject = cameraStream;
        $('video').hidden = false;
        $('cameraActions').hidden = false;
    } catch (e) {
        alert('Camera unavailable: ' + e.message);
    }
};

$('closeCamera').onclick = () => {
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    $('video').hidden = true;
    $('cameraActions').hidden = true;
};

$('snap').onclick = () => {
    const v = $('video'),
        c = $('canvas');

    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);

    c.toBlob(
        b => setImage(new File([b], 'camera.jpg', { type: 'image/jpeg' })),
        'image/jpeg',
        .85
    );
    $('closeCamera').click();
};

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('video').hidden) $('closeCamera').click();
});

$('message').focus();