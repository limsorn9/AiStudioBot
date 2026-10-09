# -*- coding: utf-8 -*-
import sys
import os
import torch
import torchaudio

def separate_bgm(audio_path, output_bgm_path):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    bundle = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB
    model = bundle.get_model().to(device)
    sample_rate = bundle.sample_rate

    import soundfile as sf
    data, sr = sf.read(audio_path)
    if data.ndim == 1:
        waveform = torch.from_numpy(data[None, :]).float()
    else:
        waveform = torch.from_numpy(data.T).float()

    if sr != sample_rate:
        waveform = torchaudio.functional.resample(waveform, sr, sample_rate)
    
    # Ensure stereo
    if waveform.shape[0] == 1:
        waveform = waveform.repeat(2, 1)
    
    waveform = waveform.to(device)
    ref = waveform.mean(0)
    waveform = (waveform - ref.mean()) / (ref.std() + 1e-7)

    with torch.no_grad():
        sources = model(waveform[None])
        sources = sources * ref.std() + ref.mean()
    
    # In HDEMUCS MUSDB: 0=drums, 1=bass, 2=other, 3=vocals
    # BGM is everything except vocals (drums + bass + other)
    bgm = (sources[0, 0] + sources[0, 1] + sources[0, 2]).cpu()

    sf.write(output_bgm_path, bgm.numpy().T, sample_rate)
    print("SUCCESS")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: separate_bgm.py <input_audio> <output_bgm>")
        sys.exit(1)
    separate_bgm(sys.argv[1], sys.argv[2])
