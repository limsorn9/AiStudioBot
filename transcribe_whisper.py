# -*- coding: utf-8 -*-
import sys
import json
import os
import warnings
import numpy as np

warnings.filterwarnings("ignore")

def estimate_gender(waveform, sr=16000):
    """
    Estimate speaker gender using autocorrelation fundamental frequency (F0).
    Male F0 typically 85-165 Hz.
    Female F0 typically 170-260 Hz.
    """
    if len(waveform) < int(sr * 0.15):
        return "male"
    
    try:
        # Take up to 0.6s from center of segment
        mid = len(waveform) // 2
        half_win = int(sr * 0.3)
        start_idx = max(0, mid - half_win)
        end_idx = min(len(waveform), mid + half_win)
        frame = waveform[start_idx:end_idx]
        
        # Center signal
        frame = frame - np.mean(frame)
        energy = np.sum(frame ** 2)
        if energy < 1e-4:
            return "male"
            
        corr = np.correlate(frame, frame, mode='full')
        corr = corr[len(frame)-1:]
        
        # Search pitch range: 80 Hz (lag ~200) to 280 Hz (lag ~57)
        min_lag = int(sr / 280)
        max_lag = int(sr / 80)
        
        if max_lag > len(corr):
            max_lag = len(corr) - 1
        if min_lag >= max_lag:
            return "male"
            
        valid_corr = corr[min_lag:max_lag]
        if len(valid_corr) == 0:
            return "male"
            
        peak_lag = np.argmax(valid_corr) + min_lag
        f0 = sr / float(peak_lag)
        
        return "female" if f0 > 172.0 else "male"
    except Exception:
        return "male"

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
                
                # Extract segment audio slice for pitch analysis
                start_samp = int(start_sec * sr)
                end_samp = int(end_sec * sr)
                seg_slice = raw_audio[start_samp:end_samp] if start_samp < len(raw_audio) else np.array([])
                
                gender = estimate_gender(seg_slice, sr)
                
                segments.append({
                    "start": start_sec,
                    "end": end_sec,
                    "text": txt,
                    "gender": gender
                })
        
        output = {
            "text": data.get("text", "").strip(),
            "language": data.get("language", ""),
            "segments": segments
        }
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
