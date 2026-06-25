from __future__ import annotations

import logging

from temporalio import activity

logger = logging.getLogger(__name__)


@activity.defn
def send_email(to: str, subject: str, body: str) -> bool:
    logger.info("[STUB] send_email", extra={"to": to, "subject": subject})
    return True


@activity.defn
def send_notification(user_id: str, message: str) -> bool:
    logger.info("[STUB] send_notification", extra={"user_id": user_id})
    return True
