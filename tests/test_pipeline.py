import json

import numpy as np
import soundfile as sf

from tools.song_preprocessing.llm_annotator import MockSongAnnotator
from tools.song_preprocessing.pipeline import SongPreprocessingPipeline


def test_mock_pipeline_exports_and_resumes_from_both_caches(tmp_path) -> None:
    songs_dir = tmp_path / "songs"
    songs_dir.mkdir()
    sample_rate = 22_050
    times = np.arange(sample_rate * 2) / sample_rate
    for index, frequency in enumerate((220, 440), start=1):
        waveform = (0.1 * np.sin(2 * np.pi * frequency * times)).astype(np.float32)
        waveform[:: sample_rate // index] += 0.6
        sf.write(songs_dir / f"track-{index}.wav", waveform, sample_rate)

    metadata_path = tmp_path / "tracks.json"
    metadata_path.write_text(
        json.dumps(
            [
                {"id": "one", "title": "One", "artist": "Test", "audioFile": "track-1.wav"},
                {"id": "two", "title": "Two", "artist": "Test", "audioFile": "track-2.wav"},
            ]
        ),
        encoding="utf-8",
    )
    output_path = tmp_path / "data" / "songProfiles.json"
    arguments = {
        "audio_dir": songs_dir,
        "metadata_path": metadata_path,
        "output_path": output_path,
        "cache_dir": tmp_path / "cache",
        "annotator": MockSongAnnotator(),
    }

    first = SongPreprocessingPipeline(**arguments).run()
    assert first.stats.final_profiles == 2
    assert first.stats.audio_cached == 0
    assert first.stats.llm_cached == 0
    exported = json.loads(output_path.read_text(encoding="utf-8"))
    assert len(exported) == 2
    assert all(0 <= item["energy"] <= 1 for item in exported)
    assert {item["audioFile"] for item in exported} == {"track-1.wav", "track-2.wav"}

    second = SongPreprocessingPipeline(**arguments).run()
    assert second.stats.audio_cached == 2
    assert second.stats.llm_cached == 2
