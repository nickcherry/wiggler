use tokio::sync::mpsc;
use tracing::warn;

use crate::telegram::TelegramClient;

const TELEGRAM_OUTBOX_CAPACITY: usize = 256;

#[derive(Clone)]
pub(super) struct TelegramOutbox {
    tx: Option<mpsc::Sender<String>>,
}

impl TelegramOutbox {
    pub(super) fn new(client: TelegramClient) -> Self {
        if !client.is_configured() {
            return Self { tx: None };
        }

        let (tx, mut rx) = mpsc::channel::<String>(TELEGRAM_OUTBOX_CAPACITY);
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                if let Err(error) = client.send_message(&message).await {
                    warn!(
                        error = %error,
                        "failed to send queued Telegram message"
                    );
                }
            }
        });

        Self { tx: Some(tx) }
    }

    pub(super) fn send_message(&self, message: impl Into<String>) -> bool {
        let Some(tx) = &self.tx else {
            return false;
        };
        match tx.try_send(message.into()) {
            Ok(()) => true,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                warn!("Telegram outbox full; dropped message");
                false
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                warn!("Telegram outbox closed; dropped message");
                false
            }
        }
    }
}
