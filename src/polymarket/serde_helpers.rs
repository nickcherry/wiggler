use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, de::Error as SerdeError};
use serde_json::Value;

pub fn deserialize_optional_millis<'de, D>(
    deserializer: D,
) -> Result<Option<DateTime<Utc>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    value.map(datetime_from_millis_value).transpose()
}

pub fn deserialize_millis<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    datetime_from_millis_value(value)
}

pub fn datetime_from_millis_value<E>(value: Value) -> Result<DateTime<Utc>, E>
where
    E: SerdeError,
{
    let millis = match value {
        Value::String(text) => text.trim().parse::<i64>().map_err(E::custom)?,
        Value::Number(number) => number
            .as_i64()
            .ok_or_else(|| E::custom(format!("timestamp is not an i64: {number}")))?,
        other => {
            return Err(E::custom(format!(
                "expected millisecond timestamp, got {other}"
            )));
        }
    };

    DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| E::custom(format!("invalid millisecond timestamp: {millis}")))
}

pub fn parse_json_string_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => serde_json::from_str::<Vec<String>>(&text).map_err(D::Error::custom),
        Value::Array(values) => values
            .into_iter()
            .map(|item| match item {
                Value::String(text) => Ok(text),
                other => Err(D::Error::custom(format!(
                    "expected string array item, got {other}"
                ))),
            })
            .collect(),
        other => Err(D::Error::custom(format!(
            "expected JSON string array, got {other}"
        ))),
    }
}

pub fn parse_optional_json_string_vec<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    value
        .map(|inner| match inner {
            Value::Null => Ok(None),
            Value::String(text) => serde_json::from_str::<Vec<String>>(&text)
                .map(Some)
                .map_err(D::Error::custom),
            Value::Array(values) => values
                .into_iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text),
                    other => Err(D::Error::custom(format!(
                        "expected string array item, got {other}"
                    ))),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            other => Err(D::Error::custom(format!(
                "expected JSON string array, got {other}"
            ))),
        })
        .transpose()
        .map(Option::flatten)
}
