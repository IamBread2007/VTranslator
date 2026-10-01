from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    mt_token: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    ocr_engine: str = "auto"  # auto | paddle | manga_ocr
    inpainter: str = "opencv"  # opencv | lama
    style_engine: str = "kmeans"  # kmeans | yuzu
    cache_dir: str = ".cache"
    llm_timeout_s: float = 90.0
    host: str = "127.0.0.1"
    port: int = 8765
    max_image_bytes: int = 25 * 1024 * 1024
    max_dimension: int = 20_000
    max_pixels: int = 30_000_000
