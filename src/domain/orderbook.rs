use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PriceLevel {
    pub price: Decimal,
    pub size: Decimal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BookSide {
    Bid,
    Ask,
}

#[derive(Clone, Debug, Default)]
pub struct TokenBook {
    bids: BTreeMap<Decimal, Decimal>,
    asks: BTreeMap<Decimal, Decimal>,
    pub last_timestamp: Option<DateTime<Utc>>,
    pub last_hash: Option<String>,
}

impl TokenBook {
    pub fn replace_snapshot(
        &mut self,
        bids: Vec<PriceLevel>,
        asks: Vec<PriceLevel>,
        timestamp: Option<DateTime<Utc>>,
        hash: Option<String>,
    ) {
        self.bids = levels_to_map(bids);
        self.asks = levels_to_map(asks);
        if timestamp.is_some() {
            self.last_timestamp = timestamp;
        }
        self.last_hash = hash;
    }

    pub fn apply_level(
        &mut self,
        side: BookSide,
        price: Decimal,
        size: Decimal,
        timestamp: Option<DateTime<Utc>>,
    ) {
        let levels = match side {
            BookSide::Bid => &mut self.bids,
            BookSide::Ask => &mut self.asks,
        };

        if size.is_zero() {
            levels.remove(&price);
        } else {
            levels.insert(price, size);
        }

        if timestamp.is_some() {
            self.last_timestamp = timestamp;
        }
    }

    pub fn best_bid(&self) -> Option<PriceLevel> {
        self.bids
            .iter()
            .next_back()
            .map(|(price, size)| PriceLevel {
                price: *price,
                size: *size,
            })
    }

    pub fn best_ask(&self) -> Option<PriceLevel> {
        self.asks.iter().next().map(|(price, size)| PriceLevel {
            price: *price,
            size: *size,
        })
    }

    pub fn asks(&self) -> Vec<PriceLevel> {
        self.asks
            .iter()
            .map(|(price, size)| PriceLevel {
                price: *price,
                size: *size,
            })
            .collect()
    }

    pub fn depth(&self) -> (usize, usize) {
        (self.bids.len(), self.asks.len())
    }
}

#[derive(Clone, Debug, Default)]
pub struct OrderBookSet {
    books: HashMap<String, TokenBook>,
}

impl OrderBookSet {
    pub fn book_mut(&mut self, asset_id: &str) -> &mut TokenBook {
        self.books.entry(asset_id.to_string()).or_default()
    }

    pub fn book(&self, asset_id: &str) -> Option<&TokenBook> {
        self.books.get(asset_id)
    }

    pub fn retain_only(&mut self, active_asset_ids: &HashSet<String>) {
        self.books
            .retain(|asset_id, _| active_asset_ids.contains(asset_id));
    }
}

fn levels_to_map(levels: Vec<PriceLevel>) -> BTreeMap<Decimal, Decimal> {
    levels
        .into_iter()
        .map(|level| (level.price, level.size))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rust_decimal::Decimal;

    use super::{BookSide, OrderBookSet, PriceLevel, TokenBook};

    #[test]
    fn replaces_snapshot_and_reads_best_prices() {
        let mut book = TokenBook::default();
        book.replace_snapshot(
            vec![
                PriceLevel {
                    price: Decimal::new(48, 2),
                    size: Decimal::new(10, 0),
                },
                PriceLevel {
                    price: Decimal::new(49, 2),
                    size: Decimal::new(20, 0),
                },
            ],
            vec![
                PriceLevel {
                    price: Decimal::new(52, 2),
                    size: Decimal::new(30, 0),
                },
                PriceLevel {
                    price: Decimal::new(51, 2),
                    size: Decimal::new(40, 0),
                },
            ],
            None,
            None,
        );

        assert_eq!(book.best_bid().unwrap().price, Decimal::new(49, 2));
        assert_eq!(book.best_ask().unwrap().price, Decimal::new(51, 2));
    }

    #[test]
    fn applies_delta_and_removes_zero_size_level() {
        let mut book = TokenBook::default();
        book.apply_level(
            BookSide::Bid,
            Decimal::new(50, 2),
            Decimal::new(10, 0),
            None,
        );
        book.apply_level(BookSide::Bid, Decimal::new(50, 2), Decimal::ZERO, None);

        assert!(book.best_bid().is_none());
    }

    #[test]
    fn prunes_inactive_books() {
        let mut books = OrderBookSet::default();
        books.book_mut("active");
        books.book_mut("stale");

        books.retain_only(&HashSet::from(["active".to_string()]));

        assert!(books.book("active").is_some());
        assert!(books.book("stale").is_none());
    }
}
