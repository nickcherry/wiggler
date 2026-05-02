#[derive(Clone, Copy)]
enum Align {
    Left,
    Right,
}

pub(super) struct Column {
    heading: &'static str,
    align: Align,
}

impl Column {
    pub(super) fn left(heading: &'static str) -> Self {
        Self {
            heading,
            align: Align::Left,
        }
    }

    pub(super) fn right(heading: &'static str) -> Self {
        Self {
            heading,
            align: Align::Right,
        }
    }
}

pub(super) struct Cell {
    text: String,
    kind: CellKind,
}

impl Cell {
    pub(super) fn plain(text: String) -> Self {
        Self {
            text,
            kind: CellKind::Plain,
        }
    }

    pub(super) fn pnl(text: String, value: f64) -> Self {
        Self {
            text,
            kind: CellKind::Pnl(value),
        }
    }
}

enum CellKind {
    Plain,
    Pnl(f64),
}

pub(super) struct Table {
    columns: Vec<Column>,
    rows: Vec<Vec<Cell>>,
}

impl Table {
    pub(super) fn new(columns: Vec<Column>, rows: Vec<Vec<Cell>>) -> Self {
        Self { columns, rows }
    }

    pub(super) fn render(&self, theme: &Theme) -> String {
        let widths = self.widths();
        let mut output = String::new();

        for (index, column) in self.columns.iter().enumerate() {
            if index > 0 {
                output.push_str("  ");
            }
            let padded = pad(column.heading, widths[index], column.align);
            output.push_str(&theme.bold(&padded));
        }
        output.push('\n');

        for row in &self.rows {
            for (index, cell) in row.iter().enumerate() {
                if index > 0 {
                    output.push_str("  ");
                }
                let padded = pad(&cell.text, widths[index], self.columns[index].align);
                match cell.kind {
                    CellKind::Plain => output.push_str(&padded),
                    CellKind::Pnl(value) => output.push_str(&theme.pnl(&padded, value)),
                }
            }
            output.push('\n');
        }

        output
    }

    fn widths(&self) -> Vec<usize> {
        self.columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                self.rows
                    .iter()
                    .filter_map(|row| row.get(index))
                    .map(|cell| cell.text.len())
                    .max()
                    .unwrap_or(0)
                    .max(column.heading.len())
            })
            .collect()
    }
}

fn pad(value: &str, width: usize, align: Align) -> String {
    match align {
        Align::Left => format!("{value:<width$}"),
        Align::Right => format!("{value:>width$}"),
    }
}

pub(super) struct Theme {
    pub(super) color: bool,
}

impl Theme {
    pub(super) fn heading(&self, value: &str) -> String {
        self.colorize("1;36", value)
    }

    fn bold(&self, value: &str) -> String {
        self.colorize("1", value)
    }

    pub(super) fn dim(&self, value: &str) -> String {
        self.colorize("2", value)
    }

    pub(super) fn warn(&self, value: &str) -> String {
        self.colorize("33", value)
    }

    pub(super) fn pnl(&self, value: &str, pnl: f64) -> String {
        if pnl > 0.0 {
            self.colorize("32", value)
        } else if pnl < 0.0 {
            self.colorize("31", value)
        } else {
            value.to_string()
        }
    }

    fn colorize(&self, code: &str, value: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{value}\x1b[0m")
        } else {
            value.to_string()
        }
    }
}

pub(super) fn format_usdc(value: f64) -> String {
    format_currency(value, 2)
}

pub(crate) fn format_signed_usdc(value: f64) -> String {
    if value > 0.0 {
        format!("+{}", format_usdc(value))
    } else if value < 0.0 {
        format!("-{}", format_usdc(value.abs()))
    } else {
        format_usdc(0.0)
    }
}

fn format_currency(value: f64, decimals: usize) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let raw = format!("{:.*}", decimals, value.abs());
    let (whole, fractional) = raw.split_once('.').unwrap_or((raw.as_str(), ""));
    if decimals == 0 {
        format!("{sign}${}", add_digit_grouping(whole))
    } else {
        format!("{sign}${}.{}", add_digit_grouping(whole), fractional)
    }
}

pub(super) fn format_whole_number(value: u64) -> String {
    add_digit_grouping(&value.to_string())
}

pub(crate) fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.abs() < 0.05 {
        "0%".to_string()
    } else if rounded.fract().abs() < 0.000001 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

fn format_signed_percent(value: f64) -> String {
    if value > 0.0 {
        format!("+{}", format_percent(value))
    } else {
        format_percent(value)
    }
}

pub(super) fn format_optional_signed_percent(value: Option<f64>) -> String {
    value
        .map(format_signed_percent)
        .unwrap_or_else(|| "n/a".to_string())
}

pub(super) fn format_optional_percent(value: Option<f64>) -> String {
    value
        .map(format_percent)
        .unwrap_or_else(|| "n/a".to_string())
}

pub(super) fn format_count_pct(count: u64, pct: f64) -> String {
    format!("{} ({})", format_whole_number(count), format_percent(pct))
}

fn add_digit_grouping(digits: &str) -> String {
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    grouped.chars().rev().collect()
}
