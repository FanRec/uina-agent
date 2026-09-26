"""TTS bridge service package.

Keep package import side-effect free so sibling services can reuse small helper
modules such as audio_playback without importing the full HTTP/TTS runtime.
"""
