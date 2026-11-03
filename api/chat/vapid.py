"""
產生一對 VAPID 金鑰（Web Push）：python -m chat.vapid
印出 CHAT_VAPID_PUBLIC_KEY／CHAT_VAPID_PRIVATE_KEY 兩行（base64url：公鑰 65 bytes 未壓縮 P-256 點、私鑰 32 bytes），
貼進 api/.env，再設 CHAT_VAPID_SUBJECT（mailto:你的信箱 或 https://你的網站）。私鑰只放在伺服器的設定裡。
換金鑰 ＝ 瀏覽器以前的訂閱全部作廢（App 下次開啟會重新訂閱）。
"""
import base64

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def generate() -> tuple:
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    public = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return b64url(public), b64url(private)


if __name__ == "__main__":
    public, private = generate()
    print(f"CHAT_VAPID_PUBLIC_KEY={public}")
    print(f"CHAT_VAPID_PRIVATE_KEY={private}")
