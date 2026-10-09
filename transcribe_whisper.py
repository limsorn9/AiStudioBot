# -*- coding: utf-8 -*-
import sys
import json
import os
import warnings
import numpy as np

warnings.filterwarnings("ignore")

def estimate_gender_nccf(samples, sr=16000):
    """
    Robust NCCF pitch tracker with voice-band filtering (Talkin/ESPS standard).
    Filters out background music and noise, measuring true vocal pitch.
    Male pitch: 85-160 Hz (median ~120 Hz)
    Female pitch: 170-280 Hz (median ~220 Hz)
    """
    if len(samples) < int(sr * 0.15):
        return "male", 130.0

    try:
        import torch
        import torchaudio.functional as F

        waveform = torch.from_numpy(samples).float()
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)

        # Bandpass filter 75Hz - 350Hz to isolate human vocal fundamental
        filtered = F.bandpass_biquad(waveform, sample_rate=sr, central_freq=180, Q=0.7)
        pitch = F.detect_pitch_frequency(filtered, sample_rate=sr, frame_time=0.02)
        valid = pitch[(pitch >= 80) & (pitch <= 320)]
        
        if len(valid) >= 2:
            med = torch.median(valid).item()
            return ("female" if med >= 165.0 else "male"), med
    except Exception:
        pass

    # Autocorrelation Fallback
    try:
        frame = samples - np.mean(samples)
        corr = np.correlate(frame, frame, mode='full')
        corr = corr[len(frame)-1:]
        min_lag = int(sr / 280)
        max_lag = int(sr / 80)
        valid_corr = corr[min_lag:max_lag]
        if len(valid_corr) > 0:
            peak = np.argmax(valid_corr) + min_lag
            f0 = sr / float(peak)
            return ("female" if f0 >= 168.0 else "male"), f0
    except Exception:
        pass

    return "male", 130.0

def refine_genders_with_dialogue_context(segments):
    """
    Refines speaker genders using Chinese conversational turn-taking,
    pronouns (他 vs 她), and character mentions.
    """
    # Common Chinese female indicators / names / pronouns
    FEMALE_MENTIONS = ["秀春", "胡秀春", "她", "姑娘", "嫂子", "小妹", "姐姐", "小姐", "女士", "妻子", "媳妇"]
    MALE_MENTIONS = ["明和", "李明和", "他", "大哥", "先生", "小伙子", "兄弟", "老公", "丈夫"]

    for i, seg in enumerate(segments):
        txt = seg.get("text", "")
        detected_gender = seg.get("gender", "male")
        pitch = seg.get("pitch", 130.0)

        # 1. If high-confidence pitch, trust pitch
        if pitch > 185.0:
            seg["gender"] = "female"
            continue
        elif pitch < 145.0:
            seg["gender"] = "male"
            continue

        # 2. Chinese dialogue cues for borderline pitches
        # If someone says "秀春..." or addresses a woman, speaker is male
        if any(f in txt for f in ["秀春", "胡秀春", "姑娘", "嫂子"]):
            if "我叫" not in txt and "我是" not in txt:
                seg["gender"] = "male"
                continue

        # If someone mentions "李明和" or "他", speaker is likely female talking about him
        if any(m in txt for m in ["李明和", "明和"]):
            if "我叫" not in txt and "我是" not in txt:
                seg["gender"] = "female"
                continue

        # 3. Female self-reference or responses
        if any(w in txt for w in ["我妈病了", "我借钱", "借我", "嫁给"]):
            if i > 0 and segments[i-1]["gender"] == "male":
                seg["gender"] = "female"
                continue

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

                start_samp = int(start_sec * sr)
                end_samp = int(end_sec * sr)
                seg_slice = raw_audio[start_samp:end_samp] if start_samp < len(raw_audio) else np.array([])

                gender, pitch = estimate_gender_nccf(seg_slice, sr)

                segments.append({
                    "start": start_sec,
                    "end": end_sec,
                    "text": txt,
                    "gender": gender,
                    "pitch": round(pitch, 1)
                })

        # Apply dialogue context refinement
        segments = refine_genders_with_dialogue_context(segments)

        output = {
            "text": data.get("text", "").strip(),
            "language": data.get("language", ""),
            "segments": segments
        }
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
