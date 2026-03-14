const VOICE_TONES = {
  alloy: "Balanced and calm for long-form listening.",
  ash: "Clear and measured with a steady delivery.",
  sage: "Warm and conversational for softer narration.",
  verse: "Brighter and more energetic for quick reads.",
};

const state = {
  previousTab: "home",
  availableVoices: [],
  selectedVoice: "alloy",
  jobs: [],
  previewArticle: null,
  lastJobsSignature: "",
  pollingHandle: null,
  selectedJobId: null,
};

const elements = {
  providerName: document.querySelector("#providerName"),
  providerMode: document.querySelector("#providerMode"),
  urlInput: document.querySelector("#urlInput"),
  pasteButton: document.querySelector("#pasteButton"),
  voiceButton: document.querySelector("#voiceButton"),
  selectedVoiceLabel: document.querySelector("#selectedVoiceLabel"),
  submitButton: document.querySelector("#submitButton"),
  voiceCreateButton: document.querySelector("#voiceCreateButton"),
  jumpToLibraryButton: document.querySelector("#jumpToLibraryButton"),
  refreshButton: document.querySelector("#refreshButton"),
  formMessage: document.querySelector("#formMessage"),
  homeSnapshot: document.querySelector("#homeSnapshot"),
  voiceSamples: document.querySelector("#voiceSamples"),
  jobsList: document.querySelector("#jobsList"),
  jobTemplate: document.querySelector("#jobTemplate"),
  snapshotTemplate: document.querySelector("#snapshotTemplate"),
  voiceSampleTemplate: document.querySelector("#voiceSampleTemplate"),
  previewTitle: document.querySelector("#previewTitle"),
  previewMeta: document.querySelector("#previewMeta"),
  previewExcerpt: document.querySelector("#previewExcerpt"),
  previewButton: document.querySelector("#previewButton"),
  previewStatus: document.querySelector("#previewStatus"),
  voiceBackButton: document.querySelector("#voiceBackButton"),
  statTotal: document.querySelector("#statTotal"),
  statReady: document.querySelector("#statReady"),
  statMinutes: document.querySelector("#statMinutes"),
  playerBackButton: document.querySelector("#playerBackButton"),
  playerOpenLinkButton: document.querySelector("#playerOpenLinkButton"),
  playerReadyView: document.querySelector("#playerReadyView"),
  playerProcessingView: document.querySelector("#playerProcessingView"),
  playerEmptyView: document.querySelector("#playerEmptyView"),
  playerTitle: document.querySelector("#playerTitle"),
  playerSource: document.querySelector("#playerSource"),
  playerVoice: document.querySelector("#playerVoice"),
  processingTitle: document.querySelector("#processingTitle"),
  processingSubtitle: document.querySelector("#processingSubtitle"),
  playerAudio: document.querySelector("#playerAudio"),
  playerSeek: document.querySelector("#playerSeek"),
  playerCurrentTime: document.querySelector("#playerCurrentTime"),
  playerDuration: document.querySelector("#playerDuration"),
  playerToggleButton: document.querySelector("#playerToggleButton"),
  playerRestartButton: document.querySelector("#playerRestartButton"),
  playerForwardButton: document.querySelector("#playerForwardButton"),
  playerVolume: document.querySelector("#playerVolume"),
  speedButtons: document.querySelector("#speedButtons"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  screens: Array.from(document.querySelectorAll(".screen")),
};

boot();

async function boot() {
  wireEvents();
  await Promise.all([loadConfig(), loadVoices(), refreshJobs()]);
  syncVoiceSummary();
  renderPlayer();
  startPolling();
}

function wireEvents() {
  elements.submitButton.addEventListener("click", () => createJob({ navigateToPlayer: true }));
  elements.voiceCreateButton.addEventListener("click", () => createJob({ navigateToPlayer: true }));
  elements.refreshButton.addEventListener("click", refreshJobs);
  elements.previewButton.addEventListener("click", reviewArticle);
  elements.voiceButton.addEventListener("click", () => setActiveTab("voice"));
  elements.voiceBackButton.addEventListener("click", () => setActiveTab(state.previousTab || "home"));
  elements.jumpToLibraryButton.addEventListener("click", () => setActiveTab("library"));
  elements.playerBackButton.addEventListener("click", () => setActiveTab("library"));
  elements.playerOpenLinkButton.addEventListener("click", openSelectedArticle);
  elements.pasteButton.addEventListener("click", pasteFromClipboard);
  elements.playerToggleButton.addEventListener("click", togglePlayback);
  elements.playerRestartButton.addEventListener("click", restartPlayback);
  elements.playerForwardButton.addEventListener("click", skipForward);
  elements.playerSeek.addEventListener("input", handleSeek);
  elements.playerVolume.addEventListener("input", handleVolumeChange);
  elements.playerAudio.addEventListener("timeupdate", syncPlayerTime);
  elements.playerAudio.addEventListener("loadedmetadata", syncPlayerTime);
  elements.playerAudio.addEventListener("ended", () => {
    elements.playerToggleButton.textContent = "Play";
  });

  elements.speedButtons.addEventListener("click", (event) => {
    const button = event.target.closest(".speed-button");
    if (!button) {
      return;
    }

    const nextSpeed = Number(button.dataset.speed);
    elements.playerAudio.playbackRate = nextSpeed;
    for (const candidate of elements.speedButtons.querySelectorAll(".speed-button")) {
      candidate.classList.toggle("speed-active", candidate === button);
    }
  });

  for (const tabButton of elements.tabButtons) {
    tabButton.addEventListener("click", () => setActiveTab(tabButton.dataset.tab));
  }
}

async function loadConfig() {
  try {
    const data = await fetchJson("/api/config");
    elements.providerName.textContent = data.provider;
    elements.providerMode.textContent = data.openAiConfigured ? "Live OpenAI" : "Fake local mode";
  } catch {
    elements.providerName.textContent = "Unavailable";
    elements.providerMode.textContent = "Config error";
  }
}

async function loadVoices() {
  try {
    const data = await fetchJson("/api/voices");
    state.availableVoices = data.voices || [];
    if (state.availableVoices.length && !state.availableVoices.includes(state.selectedVoice)) {
      state.selectedVoice = state.availableVoices[0];
    }
    syncVoiceSummary();
    renderVoiceSamples();
  } catch {
    state.availableVoices = [];
    elements.voiceSamples.innerHTML = '<p class="empty-state">No voices available.</p>';
  }
}

async function refreshJobs() {
  try {
    const payload = await fetchJson("/api/jobs");
    const jobs = payload.jobs || [];
    const signature = JSON.stringify(
      jobs.map((job) => ({
        id: job.id,
        status: job.status,
        updatedAt: job.updatedAt,
        audioUrl: job.audioUrl,
        playlistUrl: job.playlistUrl,
        error: job.error,
        voice: job.speechOptions?.voice,
      })),
    );

    if (signature === state.lastJobsSignature) {
      return;
    }

    state.jobs = jobs;
    state.lastJobsSignature = signature;

    if (!state.selectedJobId && jobs.length) {
      state.selectedJobId = jobs[0].id;
    }

    const selectedExists = jobs.some((job) => job.id === state.selectedJobId);
    if (!selectedExists) {
      state.selectedJobId = jobs[0]?.id ?? null;
    }

    renderHomeSnapshot();
    renderLibrary();
    renderPlayer();
  } catch {
    renderEmptyState(elements.jobsList, "Unable to load jobs.");
    renderEmptyState(elements.homeSnapshot, "Unable to load recent activity.");
  }
}

async function createJob({ navigateToPlayer }) {
  const url = elements.urlInput.value.trim();

  if (!url) {
    setMessage("Enter a URL first.", true);
    return;
  }

  setLoading(true);
  setMessage("Creating audio job...", false);

  try {
    const payload = await fetchJson("/api/jobs", {
      method: "POST",
      body: {
        url,
        speechOptions: {
          voice: state.selectedVoice,
        },
      },
    });

    const createdJob = payload.job;
    state.selectedJobId = createdJob.id;
    elements.urlInput.value = "";
    setMessage("Job queued. Polling for narration status...", false);
    await refreshJobs();
    if (navigateToPlayer) {
      setActiveTab("player");
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Failed to create audio job.", true);
  } finally {
    setLoading(false);
  }
}

async function reviewArticle() {
  const url = elements.urlInput.value.trim();
  if (!url) {
    updatePreviewStatus("Paste a URL on Home first.");
    setActiveTab("home");
    return;
  }

  updatePreviewStatus("Reviewing article...");

  try {
    const payload = await fetchJson("/api/extract", {
      method: "POST",
      body: { url },
    });

    state.previewArticle = payload.article;
    renderPreviewArticle();
    updatePreviewStatus("Ready");
  } catch (error) {
    updatePreviewStatus(error instanceof Error ? error.message : "Preview failed.");
  }
}

function renderPreviewArticle() {
  const article = state.previewArticle;
  if (!article) {
    elements.previewTitle.textContent = "Paste a URL on the home screen to preview it here.";
    elements.previewMeta.textContent = "No article preview loaded yet.";
    elements.previewExcerpt.textContent =
      "This screen mirrors the pen design and uses the existing extraction endpoint when you ask for a preview.";
    return;
  }

  elements.previewTitle.textContent = article.title || "Untitled article";
  elements.previewMeta.textContent = [
    article.siteName,
    article.byline,
    `${article.estimatedMinutes} min listen`,
  ]
    .filter(Boolean)
    .join("  •  ");
  elements.previewExcerpt.textContent =
    article.excerpt || article.textContent.slice(0, 180) || "No summary available.";
}

function renderVoiceSamples() {
  if (!state.availableVoices.length) {
    renderEmptyState(elements.voiceSamples, "No voices available.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const voice of state.availableVoices) {
    const node = elements.voiceSampleTemplate.content.firstElementChild.cloneNode(true);
    const name = node.querySelector(".voice-name");
    const tone = node.querySelector(".voice-tone");
    const previewButton = node.querySelector(".voice-preview-button");
    const useButton = node.querySelector(".voice-use-button");
    const player = node.querySelector(".voice-preview-player");

    name.textContent = capitalize(voice);
    tone.textContent = VOICE_TONES[voice] || "OpenAI-supported narration voice.";
    useButton.classList.toggle("voice-selected", voice === state.selectedVoice);
    useButton.textContent = voice === state.selectedVoice ? "Selected" : "Use";

    useButton.addEventListener("click", () => {
      state.selectedVoice = voice;
      syncVoiceSummary();
      renderVoiceSamples();
      renderLibrary();
      renderPlayer();
      setMessage(`Voice selected: ${voice}`, false);
    });

    previewButton.addEventListener("click", async () => {
      previewButton.disabled = true;
      previewButton.textContent = "Generating...";
      try {
        const payload = await fetchJson("/api/voice-previews", {
          method: "POST",
          body: { voice },
        });

        player.src = payload.preview.audioUrl;
        player.hidden = false;
        await player.play();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Failed to generate voice preview.",
          true,
        );
      } finally {
        previewButton.disabled = false;
        previewButton.textContent = "Generate sample";
      }
    });

    fragment.appendChild(node);
  }

  elements.voiceSamples.replaceChildren(fragment);
}

function renderHomeSnapshot() {
  const jobs = state.jobs.slice(0, 3);
  if (!jobs.length) {
    renderEmptyState(elements.homeSnapshot, "No jobs yet. Create your first narration from the card above.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const job of jobs) {
    const node = elements.snapshotTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".snapshot-status").textContent = humanizeStatus(job.status);
    node.querySelector(".snapshot-title").textContent = job.article.title || "Untitled article";
    node.querySelector(".snapshot-open").addEventListener("click", () => openJob(job.id));
    fragment.appendChild(node);
  }

  elements.homeSnapshot.replaceChildren(fragment);
}

function renderLibrary() {
  renderStats();

  if (!state.jobs.length) {
    renderEmptyState(elements.jobsList, "No narrations yet. Start one from the Home tab.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const job of state.jobs) {
    const node = elements.jobTemplate.content.firstElementChild.cloneNode(true);
    const status = node.querySelector(".job-status");
    const title = node.querySelector(".job-title");
    const meta = node.querySelector(".job-meta");
    const excerpt = node.querySelector(".job-excerpt");
    const note = node.querySelector(".job-note");
    const audioLink = node.querySelector(".job-audio-link");
    const sourceButton = node.querySelector(".job-source-link");
    const openPlayerButton = node.querySelector(".open-player-button");
    const variationSelect = node.querySelector(".job-voice-select");
    const variationButton = node.querySelector(".job-variation-button");

    status.textContent = humanizeStatus(job.status);
    status.dataset.status = job.status;
    title.textContent = job.article.title || "Untitled article";
    meta.textContent = [
      job.article.siteName,
      job.speechOptions.voice,
      `${job.article.estimatedMinutes} min`,
      formatTimestamp(job.createdAt),
    ]
      .filter(Boolean)
      .join("  •  ");
    excerpt.textContent = job.article.excerpt || job.article.textContent.slice(0, 160);
    note.textContent = buildStatusMessage(job);

    if (job.audioUrl || job.playlistUrl) {
      audioLink.hidden = false;
      audioLink.href = job.audioUrl || job.playlistUrl;
      audioLink.textContent = "Open audio";
    } else {
      audioLink.hidden = true;
      audioLink.removeAttribute("href");
    }

    sourceButton.addEventListener("click", () => {
      if (job.article.url) {
        window.open(job.article.url, "_blank", "noopener,noreferrer");
      }
    });

    openPlayerButton.addEventListener("click", () => openJob(job.id));

    syncVoiceSelectOptions(variationSelect, job.speechOptions.voice);
    variationButton.addEventListener("click", async () => {
      variationButton.disabled = true;
      try {
        await createVariation(job.article.url, variationSelect.value, job.id);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to create variation.", true);
      } finally {
        variationButton.disabled = false;
      }
    });

    fragment.appendChild(node);
  }

  elements.jobsList.replaceChildren(fragment);
}

function renderStats() {
  const totalJobs = state.jobs.length;
  const readyJobs = state.jobs.filter((job) => job.status === "completed").length;
  const totalMinutes = state.jobs.reduce((sum, job) => sum + (job.article.estimatedMinutes || 0), 0);

  elements.statTotal.textContent = String(totalJobs);
  elements.statReady.textContent = String(readyJobs);
  elements.statMinutes.textContent = String(totalMinutes);
}

function renderPlayer() {
  const job = getSelectedJob();

  elements.playerReadyView.hidden = true;
  elements.playerProcessingView.hidden = true;
  elements.playerEmptyView.hidden = true;

  if (!job) {
    elements.playerEmptyView.hidden = false;
    elements.playerOpenLinkButton.disabled = true;
    detachAudioSource();
    return;
  }

  elements.playerOpenLinkButton.disabled = false;

  if (job.status !== "completed" || !(job.audioUrl || job.playlistUrl)) {
    elements.playerProcessingView.hidden = false;
    elements.processingTitle.textContent =
      job.status === "failed" ? "Narration failed" : "Generating narration...";
    elements.processingSubtitle.textContent =
      job.status === "failed"
        ? job.error || "This job failed before audio was generated."
        : `${job.article.title || "Current article"} is still ${humanizeStatus(job.status).toLowerCase()}.`;
    detachAudioSource();
    return;
  }

  elements.playerReadyView.hidden = false;
  elements.playerTitle.textContent = job.article.title || "Untitled article";
  elements.playerSource.textContent = [job.article.siteName, `${job.article.estimatedMinutes} min read`]
    .filter(Boolean)
    .join("  •  ");
  elements.playerVoice.textContent = `Narrated by ${capitalize(job.speechOptions.voice)}`;

  const source = job.audioUrl || job.playlistUrl;
  if (elements.playerAudio.dataset.jobId !== job.id) {
    elements.playerAudio.src = source;
    elements.playerAudio.dataset.jobId = job.id;
    elements.playerAudio.load();
    elements.playerToggleButton.textContent = "Play";
  }

  syncPlayerTime();
}

function setActiveTab(nextTab) {
  if (!nextTab) {
    return;
  }

  if (nextTab !== "voice") {
    state.previousTab = nextTab;
  }

  for (const screen of elements.screens) {
    screen.classList.toggle("screen-active", screen.dataset.screen === nextTab);
  }

  for (const tabButton of elements.tabButtons) {
    const activeTab =
      nextTab === "voice" ? state.previousTab : nextTab === "player" ? "library" : nextTab;
    const matches = tabButton.dataset.tab === activeTab;
    tabButton.classList.toggle("tab-active", matches);
  }

  if (nextTab === "voice") {
    renderPreviewArticle();
  }
}

function setMessage(text, isError) {
  elements.formMessage.textContent = text;
  elements.formMessage.style.color = isError ? "#a14f45" : "#5f5b53";
}

function setLoading(isLoading) {
  elements.submitButton.disabled = isLoading;
  elements.voiceCreateButton.disabled = isLoading;
  elements.submitButton.textContent = isLoading ? "Creating..." : "Start Narrating";
  elements.voiceCreateButton.textContent = isLoading ? "Creating..." : "Create Narration";
}

function syncVoiceSummary() {
  elements.selectedVoiceLabel.textContent = state.selectedVoice;
}

function syncVoiceSelectOptions(select, selectedValue) {
  select.replaceChildren(
    ...state.availableVoices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice;
      option.textContent = capitalize(voice);
      option.selected = voice === selectedValue;
      return option;
    }),
  );
}

async function createVariation(url, voice, sourceJobId) {
  setMessage(`Creating a ${voice} variation...`, false);
  const payload = await fetchJson("/api/jobs", {
    method: "POST",
    body: {
      url,
      speechOptions: { voice },
    },
  });

  state.selectedJobId = payload.job?.id || sourceJobId;
  await refreshJobs();
}

function openJob(jobId) {
  state.selectedJobId = jobId;
  renderPlayer();
  setActiveTab("player");
}

function openSelectedArticle() {
  const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
  if (!job?.article?.url) {
    return;
  }

  window.open(job.article.url, "_blank", "noopener,noreferrer");
}

async function pasteFromClipboard() {
  if (!navigator.clipboard?.readText) {
    setMessage("Clipboard paste is not available in this browser.", true);
    return;
  }

  try {
    const value = (await navigator.clipboard.readText()).trim();
    if (!value) {
      setMessage("Clipboard is empty.", true);
      return;
    }
    elements.urlInput.value = value;
    setMessage("URL pasted from clipboard.", false);
  } catch {
    setMessage("Clipboard access was denied.", true);
  }
}

function togglePlayback() {
  if (!elements.playerAudio.src) {
    return;
  }

  if (elements.playerAudio.paused) {
    void elements.playerAudio.play();
    elements.playerToggleButton.textContent = "Pause";
  } else {
    elements.playerAudio.pause();
    elements.playerToggleButton.textContent = "Play";
  }
}

function restartPlayback() {
  if (!elements.playerAudio.src) {
    return;
  }

  elements.playerAudio.currentTime = 0;
  syncPlayerTime();
}

function skipForward() {
  if (!elements.playerAudio.src) {
    return;
  }

  elements.playerAudio.currentTime = Math.min(
    elements.playerAudio.duration || 0,
    elements.playerAudio.currentTime + 15,
  );
  syncPlayerTime();
}

function handleSeek() {
  if (!elements.playerAudio.duration) {
    return;
  }

  elements.playerAudio.currentTime = elements.playerAudio.duration * Number(elements.playerSeek.value);
  syncPlayerTime();
}

function handleVolumeChange() {
  elements.playerAudio.volume = Number(elements.playerVolume.value);
}

function syncPlayerTime() {
  const duration = Number.isFinite(elements.playerAudio.duration) ? elements.playerAudio.duration : 0;
  const currentTime = Number.isFinite(elements.playerAudio.currentTime)
    ? elements.playerAudio.currentTime
    : 0;

  elements.playerCurrentTime.textContent = formatDuration(currentTime);
  elements.playerDuration.textContent = formatDuration(duration);

  if (duration > 0) {
    elements.playerSeek.value = String(currentTime / duration);
  } else {
    elements.playerSeek.value = "0";
  }

  elements.playerToggleButton.textContent = elements.playerAudio.paused ? "Play" : "Pause";
}

function detachAudioSource() {
  elements.playerAudio.pause();
  elements.playerAudio.removeAttribute("src");
  elements.playerAudio.dataset.jobId = "";
  elements.playerToggleButton.textContent = "Play";
  elements.playerCurrentTime.textContent = "0:00";
  elements.playerDuration.textContent = "0:00";
  elements.playerSeek.value = "0";
}

function buildStatusMessage(job) {
  if (job.status === "processing") {
    return "Generating audio. This can take a moment for longer articles.";
  }

  if (job.status === "queued") {
    return "Queued for audio generation.";
  }

  if (job.status === "failed") {
    return job.error || "Audio generation failed.";
  }

  return "Ready to play.";
}

function updatePreviewStatus(text) {
  elements.previewStatus.textContent = text;
}

function getSelectedJob() {
  return state.jobs.find((candidate) => candidate.id === state.selectedJobId) ?? null;
}

function renderEmptyState(container, message) {
  container.innerHTML = `<p class="empty-state">${message}</p>`;
}

function humanizeStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatDuration(totalSeconds) {
  const rounded = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function fetchJson(url, options = {}) {
  const requestInit = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  };

  if ("body" in requestInit && requestInit.body && typeof requestInit.body !== "string") {
    requestInit.body = JSON.stringify(requestInit.body);
  }

  const response = await fetch(url, requestInit);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function startPolling() {
  stopPolling();
  state.pollingHandle = window.setInterval(refreshJobs, 3000);
}

function stopPolling() {
  if (state.pollingHandle) {
    window.clearInterval(state.pollingHandle);
    state.pollingHandle = null;
  }
}
