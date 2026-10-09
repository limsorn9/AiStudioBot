# -*- coding: utf-8 -*-
import sys
import json
import os
import warnings

warnings.filterwarnings("ignore")

def transcribe(audio_path, model_name="tiny"):
    import whisper
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path, fp16=False)
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio path provided"}))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "tiny"
    
    try:
        data = transcribe(audio_path, model_name)
        segments = []
        for s in data.get("segments", []):
            txt = s.get("text", "").strip()
            if txt:
                segments.append({
                    "start": round(s.get("start", 0), 2),
                    "end": round(s.get("end", 0), 2),
                    "text": txt
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

