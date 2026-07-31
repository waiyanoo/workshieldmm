/**
 * Structured NRC entry.
 *
 * An NRC is `<state>/<township><type><6 digits>`. Only the last part is a
 * number a person reads off a card; the first three are codes from fixed lists,
 * and the township code is printed on the card in BURMESE while this platform
 * stores a Latin transliteration. Asking someone to type "OUKAMA" from looking
 * at "ဥကမ" is asking them to invent a spelling, and a wrong one silently
 * creates a second subject for a person who already exists.
 *
 * So: three pickers and one number field. Each township option is one line —
 * the Burmese code as printed on the card, then the Latin one we store — so a
 * few hundred rows stay scannable. Township names are searchable but not shown:
 * they double the height of every row and nobody is copying them.
 *
 * It stays a free-text fallback underneath. Township codes change as townships
 * are created and renamed, and a stale local list must never be the reason a
 * real person cannot be checked — an unrecognised code warns and proceeds.
 */
import { useMemo } from "react";
import {
  Autocomplete,
  Box,
  FormHelperText,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  NRC_STATES,
  NRC_TYPES,
  formatNrc,
  isKnownTownship,
  parseNrc,
  townshipsForState,
  type NrcTownship,
} from "@hyper/shared";
import { useTranslation } from "react-i18next";

export interface NrcValue {
  state: number | "";
  township: string;
  type: string;
  number: string;
}

export const EMPTY_NRC: NrcValue = { state: "", township: "", type: "N", number: "" };

/** The composed NRC, or "" when the parts are not yet a complete one. */
export function nrcToString(v: NrcValue): string {
  if (v.state === "" || !v.township.trim() || !v.type || v.number.length !== 6) return "";
  return formatNrc({
    state: Number(v.state),
    township: v.township.trim().toUpperCase(),
    type: v.type,
    number: v.number,
  });
}

/** Split an existing NRC back into parts, for editing a stored value. */
export function nrcFromString(raw: string): NrcValue {
  const parsed = parseNrc(raw);
  if (!parsed) return { ...EMPTY_NRC };
  return {
    state: parsed.state,
    township: parsed.township,
    type: parsed.type,
    number: parsed.number,
  };
}

export function NrcInput({
  value,
  onChange,
  disabled,
  required,
}: {
  value: NrcValue;
  onChange: (next: NrcValue) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const { t } = useTranslation();

  const townships = useMemo(
    () => (value.state === "" ? [] : townshipsForState(Number(value.state))),
    [value.state]
  );

  const composed = nrcToString(value);
  const township = value.township.trim();

  // Burmese is a search term, not a value: the stored code is the Latin
  // transliteration. Someone can type "ဥကမ" to FIND the row, but leaving it
  // unselected would put Burmese into the identifier, so say so rather than
  // just leaving Submit greyed out with no reason given.
  const needsSelection = township.length > 0 && !/^[A-Z]+$/.test(township);

  const unknownTownship =
    !needsSelection &&
    value.state !== "" &&
    township.length > 0 &&
    !isKnownTownship(Number(value.state), township);

  return (
    <Box>
      {/* Wraps rather than switching on a viewport breakpoint. This sits in a
          wide form on the checks page and in a ~400px card on registration, and
          a breakpoint only knows about the window — so on a wide screen the
          narrow card overflowed and pushed the number field out of sight. */}
      <Stack
        direction="row"
        spacing={1.5}
        rowGap={1.5}
        alignItems="flex-start"
        flexWrap="wrap"
        useFlexGap
      >
        <TextField
          select
          size="small"
          label={t("nrc.state")}
          value={value.state}
          disabled={disabled}
          required={required}
          onChange={(e) =>
            // Township codes are scoped to a state, so the one already picked
            // is meaningless under a different one. Clearing beats leaving a
            // code that silently belongs to somewhere else.
            onChange({ ...value, state: Number(e.target.value), township: "" })
          }
          sx={{ width: 104 }}
        >
          {NRC_STATES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>

        <Autocomplete
          size="small"
          freeSolo
          disabled={disabled || value.state === ""}
          options={townships}
          // inputValue-controlled, not value-controlled. With `value` MUI
          // resets the input to the selected option's label and the filter
          // never sees what was typed, so searching did nothing.
          inputValue={value.township}
          // Capped: the longest code is a dozen characters, so letting this
          // field absorb all the leftover width just makes it look like the
          // important part of the row when it is one code among four.
          sx={{ flex: "1 1 150px", minWidth: 140, maxWidth: 230 }}
          // Both scripts searchable: the operator may be reading Burmese off a
          // card or copying a Latin code from another system.
          filterOptions={(opts, state) => {
            const q = state.inputValue.trim().toLowerCase();
            if (!q) return opts;
            return (opts as NrcTownship[]).filter(
              (o) =>
                o.code.toLowerCase().includes(q) ||
                o.codeMm.includes(state.inputValue.trim()) ||
                o.nameMm.includes(state.inputValue.trim())
            );
          }}
          getOptionLabel={(o) => (typeof o === "string" ? o : o.code)}
          onInputChange={(_, input) =>
            // Upper-cased for the Latin code; Burmese is unaffected by casing,
            // so searching in either script still works.
            onChange({ ...value, township: input.toUpperCase() })
          }
          onChange={(_, picked) =>
            onChange({
              ...value,
              township: typeof picked === "string" ? picked.toUpperCase() : (picked?.code ?? ""),
            })
          }
          // One line per option: the two codes, nothing else. The township name
          // is what makes a 400-row list unreadable, and it is not what anyone
          // is copying — the code is. It stays searchable above, so someone who
          // knows the township but not its code can still find the row.
          renderOption={(props, o) => {
            const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
            const town = o as NrcTownship;
            return (
              <li key={key ?? town.code} {...rest}>
                <Typography variant="body2" noWrap>
                  {town.codeMm}{" "}
                  <Typography component="span" variant="caption" color="text.secondary">
                    ({town.code})
                  </Typography>
                </Typography>
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={t("nrc.township")}
              required={required}
              placeholder={value.state === "" ? t("nrc.pickStateFirst") : ""}
            />
          )}
        />

        <TextField
          select
          size="small"
          label={t("nrc.type")}
          value={value.type}
          disabled={disabled}
          required={required}
          onChange={(e) => onChange({ ...value, type: e.target.value })}
          sx={{ width: 116 }}
        >
          {NRC_TYPES.map((ty) => (
            <MenuItem key={ty.code} value={ty.code}>
              {ty.labelMm} ({ty.code})
            </MenuItem>
          ))}
        </TextField>

        <TextField
          size="small"
          label={t("nrc.number")}
          value={value.number}
          disabled={disabled}
          required={required}
          // Six digits, digits only. Rejecting the seventh keystroke is kinder
          // than accepting it and failing on submit.
          onChange={(e) =>
            onChange({ ...value, number: e.target.value.replace(/[^0-9]/g, "").slice(0, 6) })
          }
          inputProps={{ inputMode: "numeric", maxLength: 6 }}
          sx={{ flex: "0 1 132px", minWidth: 120 }}
        />
      </Stack>

      <Stack direction="row" spacing={1} alignItems="baseline" mt={0.75} flexWrap="wrap">
        {/* Echo the composed value: the operator can read it back against the
            card in one glance, which is the check that actually catches a
            mis-picked township. */}
        <FormHelperText sx={{ m: 0 }}>
          {composed ? (
            <Box component="span" sx={{ fontFamily: "monospace", fontSize: 13 }}>
              {composed}
            </Box>
          ) : (
            t("nrc.incomplete")
          )}
        </FormHelperText>
        {needsSelection && (
          <FormHelperText sx={{ m: 0, color: "warning.main" }}>
            {t("nrc.pickFromList")}
          </FormHelperText>
        )}
        {unknownTownship && (
          <FormHelperText sx={{ m: 0, color: "warning.main" }}>
            {t("nrc.unknownTownship")}
          </FormHelperText>
        )}
      </Stack>
    </Box>
  );
}
