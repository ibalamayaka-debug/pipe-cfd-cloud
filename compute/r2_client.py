"""
Cloudflare R2 (S3-compatible) helper for Modal & Google Cloud Run compute workers.
R2 gives 10 GB/month free storage and $0 egress fees permanently.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Optional


def get_r2_client():
    import boto3
    from botocore.config import Config

    account_id = os.environ["R2_ACCOUNT_ID"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def upload_case_to_r2(case_key: str, output_dir: Path) -> Dict[str, str]:
    """Upload wall.vtp, slice.vtp, vectors.vtp, and metrics.json to Cloudflare R2."""
    bucket = os.environ["R2_BUCKET_NAME"]
    client = get_r2_client()

    content_types = {
        "wall.vtp": "application/xml",
        "slice.vtp": "application/xml",
        "vectors.vtp": "application/xml",
        "metrics.json": "application/json",
    }

    uploaded: Dict[str, str] = {}
    for fname, ctype in content_types.items():
        fpath = output_dir / fname
        if not fpath.exists():
            continue
        object_key = f"cases/{case_key}/{fname}"
        client.upload_file(
            str(fpath),
            bucket,
            object_key,
            ExtraArgs={
                "ContentType": ctype,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        uploaded[fname] = object_key
    return uploaded


def read_cached_metrics_from_r2(case_key: str) -> Optional[Dict[str, object]]:
    """Return cached metrics.json from R2 if this exact parameter set was already computed."""
    bucket = os.environ["R2_BUCKET_NAME"]
    client = get_r2_client()
    try:
        obj = client.get_object(Bucket=bucket, Key=f"cases/{case_key}/metrics.json")
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception:
        return None
