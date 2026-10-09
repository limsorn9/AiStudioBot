# -*- coding: utf-8 -*-
import sys
import json
import os
import warnings
import numpy as np

warnings.filterwarnings("ignore")

def extract_segment_features(samples, sr=16000):
    """
    Extracts acoustic biometric features for Speaker Diarization / Voice Clustering:
    1. Pitch fundamental frequency F0
    2. Spectral centroid (vocal tract length / formant brightness)
    """
    if len(samples) < int(sr * 0.15):
        return 130.0, 1500.0

    samples = samples - np.mean(samples)

    # 1. Spectral Centroid
    fft = np.abs(np.fft.rfft(samples[:min(len(samples), sr * 2)]))
    freqs = np.fft.rfftfreq(len(samples[:min(len(samples), sr * 2)]), 1.0 / sr)
    centroid = float(np.sum(freqs * fft) / (np.sum(fft) + 1e-7))

    # 2. Pitch F0
    f0 = 130.0
    try:
        import torch
        import torchaudio.functional as F

        waveform = torch.from_numpy(samples).float().unsqueeze(0)
        filtered = F.bandpass_biquad(waveform, sample_rate=sr, central_freq=180, Q=0.7)
        pitch = F.detect_pitch_frequency(filtered, sample_rate=sr, frame_time=0.02)
        valid = pitch[(pitch >= 80) & (pitch <= 320)]
        if len(valid) >= 2:
            f0 = float(torch.median(valid).item())
    except Exception:
        # Autocorrelation fallback
        corr = np.correlate(samples, samples, mode='full')[len(samples)-1:]
        min_lag = int(sr / 300)
        max_lag = int(sr / 75)
        valid_corr = corr[min_lag:max_lag]
        if len(valid_corr) > 0:
            peak = np.argmax(valid_corr) + min_lag
            f0 = float(sr / peak)

    return f0, centroid

def cluster_speakers_kmeans2(scores, max_iter=25):
    """
    Pure NumPy 2-means clustering to separate male vs female dialogue clusters
    across the entire conversation.
    """
    if len(scores) < 2:
        return np.zeros(len(scores), dtype=int)

    c1 = float(np.min(scores))
    c2 = float(np.max(scores))

    labels = np.zeros(len(scores), dtype=int)
    for _ in range(max_iter):
        d1 = np.abs(scores - c1)
        d2 = np.abs(scores - c2)
        new_labels = (d2 < d1).astype(int)
        if np.array_equal(labels, new_labels):
            break
        labels = new_labels
        if np.sum(labels == 0) > 0:
            c1 = float(np.mean(scores[labels == 0]))
        if np.sum(labels == 1) > 0:
            c2 = float(np.mean(scores[labels == 1]))

    # Label 1 is always the higher centroid (female)
    if c1 > c2:
        labels = 1 - labels

    return labels

def diarize_and_classify_speakers(segments, raw_audio, sr=16000):
    """
    Performs global 2-Speaker Voice Diarization across all segments.
    """
    if not segments:
        return segments

    f0_list = []
    cent_list = []

    for seg in segments:
        start_samp = int(seg["start"] * sr)
        end_samp = int(seg["end"] * sr)
        seg_slice = raw_audio[start_samp:end_samp] if start_samp < len(raw_audio) else np.array([])
        f0, cent = extract_segment_features(seg_slice, sr)
        f0_list.append(f0)
        cent_list.append(cent)

    f0_arr = np.array(f0_list)
    cent_arr = np.array(cent_list)

    # Robust classification:
    # Typical male voice: 85Hz - 155Hz. Typical female voice: 165Hz - 260Hz.
    median_f0 = float(np.median(f0_arr))
    p25 = float(np.percentile(f0_arr, 25))
    p75 = float(np.percentile(f0_arr, 75))
    iqr_f0 = p75 - p25

    # Check if this audio has both male and female speakers (significant pitch variance and spread)
    has_dual_speakers = (p25 < 150.0 and p75 > 170.0 and iqr_f0 > 30.0)

    if not has_dual_speakers:
        # Single dominant speaker video/scene: classify entire clip consistently
        default_gender = "female" if median_f0 >= 165.0 else "male"
        for i, seg in enumerate(segments):
            seg["gender"] = default_gender
            seg["pitch"] = round(float(f0_arr[i]), 1)
    else:
        # Multi-speaker dialogue: cluster based on pitch and spectral centroid
        std_f0 = np.std(f0_arr) if np.std(f0_arr) > 1e-4 else 1.0
        std_cent = np.std(cent_arr) if np.std(cent_arr) > 1e-4 else 1.0
        norm_f0 = (f0_arr - np.mean(f0_arr)) / std_f0
        norm_cent = (cent_arr - np.mean(cent_arr)) / std_cent

        composite_scores = norm_f0 * 1.5 + norm_cent
        cluster_labels = cluster_speakers_kmeans2(composite_scores)

        # 0 = male, 1 = female
        for i, seg in enumerate(segments):
            # Pitch override: if pitch is clearly masculine or feminine, trust absolute pitch
            if f0_arr[i] < 140.0:
                seg["gender"] = "male"
            elif f0_arr[i] > 185.0:
                seg["gender"] = "female"
            else:
                seg["gender"] = "female" if cluster_labels[i] == 1 else "male"
            seg["pitch"] = round(float(f0_arr[i]), 1)

    return segments

def transcribe(audio_path, model_name="tiny"):
    import whisper
    raw_audio = whisper.load_audio(audio_path)
    model = whisper.load_model(model_name)
    result = model.transcribe(raw_audio, fp16=False)
    return result, raw_audio

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio path provided"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "tiny"

    try:
        data, raw_audio = transcribe(audio_path, model_name)
        segments = []
        sr = 16000

        for s in data.get("segments", []):
            txt = s.get("text", "").strip()
            if txt:
                start_sec = round(s.get("start", 0), 2)
                end_sec = round(s.get("end", 0), 2)
                segments.append({
                    "start": start_sec,
                    "end": end_sec,
                    "text": txt
                })

        # Run 2-Speaker Voice Diarization & Classification
        segments = diarize_and_classify_speakers(segments, raw_audio, sr)

        output = {
            "text": data.get("text", "").strip(),
            "language": data.get("language", ""),
            "segments": segments
        }
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
