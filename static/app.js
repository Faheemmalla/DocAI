const $ = id => document.getElementById(id);

const TOKEN_KEY = 'docai_token';

let history = [],
    imageData = null,
    recorder = null,
    audioChunks = [],
    cameraStream = null,
    lastAnswer = '',
    conversationId = null,
    currentAbortController = null,
    isGenerating = false,
    currentAudio = null;

/* ---------- UI helpers ---------- */
const setMic = text => {
    const s = $('mic')?.querySelector('span');
    if (s) s.textContent = text;
};

const autosize = () => {
    const t = $('message');
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
};

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatResponseText(text) {
    if (!text) return '';
    let escaped = escapeHtml(text);

    // Style PDF citations like [PDF p.4]
    escaped = escaped.replace(/\[PDF p\.(\d+)\]/g, '<span class="pdf-tag">PDF p.$1</span>');

    // Make URLs clickable
    escaped = escaped.replace(/(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    return escaped;
}

/* restore saved token */
try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) $('token').value = saved;
} catch { }

/* ---------- headers & sources ---------- */
const headers = () => {
    const h = {};
    const token = $('token').value.trim();
    if (token) h.Authorization = `Bearer ${token}`;
    if (conversationId) h['X-Conversation-ID'] = conversationId;
    return h;
};

function renderSources(el, sources = []) {
    if (!sources || !sources.length) return;
    const existing = el.querySelector('.sources');
    if (existing) existing.remove();

    const s = document.createElement('div');
    s.className = 'sources';
    s.textContent = 'Sources: ' + sources
        .slice(0, 8)
        .map(x => x.type === 'pdf' ? `PDF page ${x.page}` : (x.url || x.title || 'Web'))
        .join(' | ');

    const actions = el.querySelector('.msg-actions');
    if (actions) {
        el.insertBefore(s, actions);
    } else {
        el.appendChild(s);
    }
}

function attachMessageActions(el, rawText) {
    if (el.querySelector('.msg-actions')) return;

    const bar = document.createElement('div');
    bar.className = 'msg-actions';

    // Copy action
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-btn';
    copyBtn.innerHTML = `
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" aria-hidden="true">
            <rect x="7" y="7" width="9" height="9" rx="2" stroke="currentColor" stroke-width="1.4" />
            <path d="M4 13V5a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span>Copy</span>
    `;
    copyBtn.onclick = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(rawText);
            } else {
                const ta = document.createElement('textarea');
                ta.value = rawText;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            const span = copyBtn.querySelector('span');
            span.textContent = 'Copied ✓';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                span.textContent = 'Copy';
                copyBtn.classList.remove('copied');
            }, 1600);
        } catch { }
    };

    // Listen action
    const listenBtn = document.createElement('button');
    listenBtn.type = 'button';
    listenBtn.className = 'msg-btn';
    listenBtn.innerHTML = `
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" aria-hidden="true">
            <path d="M3.5 8v4h3l4 3.5v-11L6.5 8h-3zM13.5 7a4 4 0 010 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>Listen</span>
    `;
    listenBtn.onclick = () => playSpeech(rawText, listenBtn);

    bar.appendChild(copyBtn);
    bar.appendChild(listenBtn);
    el.appendChild(bar);
}

function bubble(text, kind = 'bot', sources = []) {
    const el = document.createElement('article');
    el.className = kind;

    if (kind === 'bot') {
        el.innerHTML = formatResponseText(text);
        if (sources.length) renderSources(el, sources);
        if (text && text !== 'Thinking…') attachMessageActions(el, text);
    } else {
        el.textContent = text;
    }

    $('messages').appendChild(el);
    scrollMessagesToBottom();
    return el;
}

/* ---------- scrolling helpers ---------- */
function isNearBottom() {
    const m = $('messages');
    return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}

function scrollMessagesToBottom(smooth = false) {
    const m = $('messages');
    if (smooth) {
        m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' });
    } else {
        m.scrollTop = m.scrollHeight;
    }
}

const scrollBtn = $('scrollBottom');
if (scrollBtn) {
    $('messages').addEventListener('scroll', () => {
        const m = $('messages');
        const show = m.scrollHeight - m.scrollTop - m.clientHeight > 140;
        scrollBtn.hidden = !show;
    });
    scrollBtn.onclick = () => scrollMessagesToBottom(true);
}

/* ---------- generator state & stop control ---------- */
function setGenerating(generating) {
    isGenerating = generating;
    const sendBtn = $('send');
    if (!sendBtn) return;
    const label = sendBtn.querySelector('span');

    if (generating) {
        sendBtn.classList.add('stop');
        sendBtn.setAttribute('title', 'Stop generating (Esc)');
        if (label) label.textContent = 'Stop';
        sendBtn.disabled = false;
    } else {
        sendBtn.classList.remove('stop');
        sendBtn.removeAttribute('title');
        if (label) label.textContent = 'Send';
        sendBtn.disabled = false;
        currentAbortController = null;
    }
}

function stopGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
}

/* ---------- health check ---------- */
async function check() {
    try {
        await fetch('/api/health');
    } catch { }
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
    $('token').focus();
}

/* ---------- new chat ---------- */
$('newChat').onclick = () => {
    if (isGenerating) stopGeneration();
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    history = [];
    conversationId = null;
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
        if (isGenerating) stopGeneration();
        $('message').value = chip.dataset.q;
        autosize();
        $('chatForm').requestSubmit();
    };
});

/* ---------- image handling & drag-and-drop ---------- */
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

// Drag and drop onto composer or window
const composer = document.querySelector('.composer');
['dragenter', 'dragover'].forEach(eventName => {
    window.addEventListener(eventName, e => {
        e.preventDefault();
        if (composer) composer.classList.add('dragover');
    });
});

['dragleave', 'drop'].forEach(eventName => {
    window.addEventListener(eventName, e => {
        e.preventDefault();
        if (e.type === 'drop') {
            const dt = e.dataTransfer;
            if (dt?.files?.length) {
                const file = dt.files[0];
                if (file.type.startsWith('image/')) setImage(file);
            }
        }
        if (composer) composer.classList.remove('dragover');
    });
});

/* ---------- chat input & shortcuts ---------- */
$('message').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (isGenerating) return;
        $('chatForm').requestSubmit();
    }
});
$('message').addEventListener('input', autosize);

/* Global Escape shortcut */
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (!$('video').hidden) {
            $('closeCamera').click();
        } else if (isGenerating) {
            stopGeneration();
        }
    }
});

/* ---------- non-streaming fallback handler ---------- */
async function fallbackNonStreaming(message, prior, pending) {
    setGenerating(true);
    let authFailed = false;
    try {
        const r = await fetch('/api/chat', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, history: prior, image_data: imageData, stream: false })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Request failed');

        pending.classList.remove('thinking');
        pending.innerHTML = formatResponseText(d.answer);
        lastAnswer = d.answer;

        if (d.sources?.length) renderSources(pending, d.sources);
        attachMessageActions(pending, d.answer);

        if (d.conversation_id) conversationId = d.conversation_id;

        history.push(
            { role: 'user', content: message },
            { role: 'assistant', content: d.answer }
        );
        $('remove').click();

        if ($('tokenbar').classList.contains('invalid')) {
            $('tokenbar').classList.remove('invalid');
        }
    } catch (err) {
        pending.classList.remove('thinking');
        pending.textContent = 'Error: ' + err.message;
        if (/invalid.*token|token.*(invalid|missing|required)|unauthori[sz]ed|forbidden/i.test(err.message)) {
            authFailed = true;
            markTokenInvalid();
        }
    } finally {
        setGenerating(false);
        scrollMessagesToBottom(true);
        if (!authFailed) $('message').focus();
    }
}

/* ---------- streaming chat submission ---------- */
$('chatForm').addEventListener('submit', async e => {
    e.preventDefault();

    if (isGenerating) {
        stopGeneration();
        return;
    }

    const message = $('message').value.trim();
    if (!message) return;

    const prior = history.slice(-8);
    $('messages').classList.add('started');
    bubble(message, 'user');
    $('message').value = '';
    autosize();

    const pending = document.createElement('article');
    pending.className = 'bot thinking';
    pending.innerHTML = 'Thinking<span class="typing-dots"><span></span><span></span><span></span></span>';
    $('messages').appendChild(pending);
    scrollMessagesToBottom();
    setGenerating(true);

    currentAbortController = new AbortController();
    const currentSignal = currentAbortController.signal;

    let accumulatedText = '';
    let receivedTokens = false;
    let authFailed = false;
    let sourcesData = [];

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
                ...headers(),
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream, application/json'
            },
            body: JSON.stringify({
                message,
                history: prior,
                image_data: imageData,
                stream: true
            }),
            signal: currentSignal
        });

        if (!response.ok) {
            let errorDetail = 'Request failed';
            try {
                const errJson = await response.json();
                errorDetail = errJson.detail || errorDetail;
            } catch {
                errorDetail = response.statusText || errorDetail;
            }
            throw new Error(errorDetail);
        }

        const contentType = response.headers.get('content-type') || '';

        // Non-streaming fallback response
        if (contentType.includes('application/json')) {
            const d = await response.json();
            pending.classList.remove('thinking');
            pending.innerHTML = formatResponseText(d.answer);
            lastAnswer = d.answer;
            if (d.sources?.length) renderSources(pending, d.sources);
            attachMessageActions(pending, d.answer);
            if (d.conversation_id) conversationId = d.conversation_id;
            history.push(
                { role: 'user', content: message },
                { role: 'assistant', content: d.answer }
            );
            $('remove').click();
            return;
        }

        // Incremental SSE stream reader
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') break;

                    try {
                        const event = JSON.parse(dataStr);
                        if (event.type === 'status') {
                            if (!receivedTokens) {
                                pending.innerHTML = escapeHtml(event.message) + '<span class="typing-dots"><span></span><span></span><span></span></span>';
                            }
                        } else if (event.type === 'delta') {
                            if (!receivedTokens) {
                                receivedTokens = true;
                                pending.classList.remove('thinking');
                                pending.textContent = '';
                            }
                            accumulatedText += event.text;
                            pending.textContent = accumulatedText;
                            if (isNearBottom()) scrollMessagesToBottom();
                        } else if (event.type === 'done') {
                            pending.classList.remove('thinking');
                            if (event.answer) {
                                accumulatedText = event.answer;
                            }
                            lastAnswer = accumulatedText;
                            if (event.conversation_id) conversationId = event.conversation_id;
                            if (event.sources?.length) sourcesData = event.sources;
                        } else if (event.type === 'error') {
                            throw new Error(event.detail || 'An error occurred during generation');
                        }
                    } catch (parseErr) {
                        if (dataStr.startsWith('{"type":"error"')) throw parseErr;
                    }
                }
            }
        }

        // Finalize completed stream
        pending.classList.remove('thinking');
        lastAnswer = accumulatedText || lastAnswer;

        // Rich format complete answer with citations and links
        pending.innerHTML = formatResponseText(lastAnswer);

        if (sourcesData.length) {
            renderSources(pending, sourcesData);
        }

        attachMessageActions(pending, lastAnswer);

        if (accumulatedText) {
            history.push(
                { role: 'user', content: message },
                { role: 'assistant', content: accumulatedText }
            );
        }

        $('remove').click();

        if ($('tokenbar').classList.contains('invalid')) {
            $('tokenbar').classList.remove('invalid');
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            pending.classList.remove('thinking');
            if (accumulatedText) {
                lastAnswer = accumulatedText;
                pending.innerHTML = formatResponseText(accumulatedText);
                attachMessageActions(pending, accumulatedText);
                history.push(
                    { role: 'user', content: message },
                    { role: 'assistant', content: accumulatedText }
                );
                const stopped = document.createElement('div');
                stopped.className = 'stream-stopped';
                stopped.textContent = '⏹ Generation stopped';
                pending.appendChild(stopped);
            } else {
                pending.textContent = '⏹ Request cancelled';
            }
        } else {
            if (!receivedTokens && !/invalid.*token|unauthori/i.test(err.message)) {
                console.warn('Stream failed before receiving tokens, falling back to non-streaming:', err.message);
                pending.textContent = 'Connection interrupted, retrying…';
                setGenerating(false);
                return await fallbackNonStreaming(message, prior, pending);
            }

            pending.classList.remove('thinking');
            if (accumulatedText) {
                pending.innerHTML = formatResponseText(accumulatedText);
                attachMessageActions(pending, accumulatedText);
                const errNotice = document.createElement('div');
                errNotice.className = 'stream-error';
                errNotice.textContent = `⚠ Stream error: ${err.message}`;
                pending.appendChild(errNotice);
            } else {
                pending.textContent = 'Error: ' + err.message;
            }

            if (/invalid.*token|token.*(invalid|missing|required)|unauthori[sz]ed|forbidden/i.test(err.message)) {
                authFailed = true;
                markTokenInvalid();
            }
        }
    } finally {
        setGenerating(false);
        scrollMessagesToBottom(true);
        if (!authFailed) $('message').focus();
    }
});

/* ---------- voice dictation ---------- */
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

/* ---------- speech audio synthesis helper ---------- */
async function playSpeech(text, triggerBtn = null) {
    if (!text) return;

    // If currently playing, toggle to stop
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        currentAudio = null;
        if (triggerBtn) {
            const span = triggerBtn.querySelector('span');
            if (span) span.textContent = triggerBtn.id === 'listen' ? 'Read answer' : 'Listen';
            triggerBtn.classList.remove('playing');
        }
        return;
    }

    if (triggerBtn) {
        triggerBtn.disabled = true;
        const span = triggerBtn.querySelector('span');
        if (span) span.textContent = 'Loading audio…';
    }

    try {
        const r = await fetch('/api/speak', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (!r.ok) throw Error('Speech unavailable');

        const url = URL.createObjectURL(await r.blob());
        const audio = new Audio(url);
        currentAudio = audio;

        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.classList.add('playing');
            const span = triggerBtn.querySelector('span');
            if (span) span.textContent = 'Stop audio';
        }

        audio.onended = () => {
            URL.revokeObjectURL(url);
            if (currentAudio === audio) currentAudio = null;
            if (triggerBtn) {
                triggerBtn.classList.remove('playing');
                const span = triggerBtn.querySelector('span');
                if (span) span.textContent = triggerBtn.id === 'listen' ? 'Read answer' : 'Listen';
            }
        };

        audio.onerror = () => {
            URL.revokeObjectURL(url);
            if (currentAudio === audio) currentAudio = null;
            if (triggerBtn) {
                triggerBtn.classList.remove('playing');
                const span = triggerBtn.querySelector('span');
                if (span) span.textContent = triggerBtn.id === 'listen' ? 'Read answer' : 'Listen';
            }
        };

        await audio.play();
    } catch (e) {
        alert(e.message);
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.classList.remove('playing');
            const span = triggerBtn.querySelector('span');
            if (span) span.textContent = triggerBtn.id === 'listen' ? 'Read answer' : 'Listen';
        }
    }
}

$('listen').onclick = () => {
    if (!lastAnswer) return alert('Ask a question first');
    playSpeech(lastAnswer, $('listen'));
};

/* ---------- camera capture ---------- */
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

$('message').focus();