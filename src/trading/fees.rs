#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidityRole {
    Maker,
    Taker,
}

pub fn platform_fee_usdc(
    shares: f64,
    price: f64,
    fee_rate: f64,
    role: LiquidityRole,
) -> Option<f64> {
    if !shares.is_finite() || !price.is_finite() || !fee_rate.is_finite() {
        return None;
    }
    if shares < 0.0 || !(0.0..=1.0).contains(&price) || fee_rate < 0.0 {
        return None;
    }
    if role == LiquidityRole::Maker {
        return Some(0.0);
    }

    Some(shares * fee_rate * price * (1.0 - price))
}

pub fn buy_gross_pnl_usdc(shares: f64, entry_price: f64, resolution_price: f64) -> Option<f64> {
    if !shares.is_finite() || !entry_price.is_finite() || !resolution_price.is_finite() {
        return None;
    }
    Some(shares * (resolution_price - entry_price))
}

pub fn buy_net_pnl_usdc(
    shares: f64,
    entry_price: f64,
    resolution_price: f64,
    entry_fee_usdc: f64,
) -> Option<f64> {
    Some(buy_gross_pnl_usdc(shares, entry_price, resolution_price)? - entry_fee_usdc)
}

pub fn realized_pnl_adjustment_usdc(gross_pnl_usdc: f64, realized_pnl_usdc: f64) -> Option<f64> {
    if !gross_pnl_usdc.is_finite() || !realized_pnl_usdc.is_finite() {
        return None;
    }
    Some(gross_pnl_usdc - realized_pnl_usdc)
}

#[cfg(test)]
mod tests {
    use super::{
        LiquidityRole, buy_gross_pnl_usdc, buy_net_pnl_usdc, platform_fee_usdc,
        realized_pnl_adjustment_usdc,
    };

    #[test]
    fn maker_platform_fee_is_zero() {
        assert_eq!(
            platform_fee_usdc(100.0, 0.50, 0.072, LiquidityRole::Maker),
            Some(0.0)
        );
    }

    #[test]
    fn taker_platform_fee_uses_polymarket_formula() {
        assert!(
            (platform_fee_usdc(100.0, 0.42, 0.072, LiquidityRole::Taker).unwrap() - 1.75392).abs()
                < 0.000001
        );
    }

    #[test]
    fn buy_net_pnl_subtracts_entry_fee() {
        let fee = platform_fee_usdc(100.0, 0.42, 0.072, LiquidityRole::Taker).unwrap();
        assert!((buy_gross_pnl_usdc(100.0, 0.42, 1.0).unwrap() - 58.0).abs() < 0.000001);
        assert!((buy_net_pnl_usdc(100.0, 0.42, 1.0, fee).unwrap() - 56.24608).abs() < 0.000001);
    }

    #[test]
    fn realized_pnl_adjustment_is_gross_minus_actual() {
        assert_eq!(realized_pnl_adjustment_usdc(58.0, 56.25), Some(1.75));
    }
}
