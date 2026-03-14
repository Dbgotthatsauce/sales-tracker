-- =============================================================
-- Sales Tracker – Datenbankschema
-- =============================================================

-- -------------------------------------------------------------
-- ENUM-ähnliche Einschränkung via CHECK für erlaubte event_types
-- -------------------------------------------------------------
-- Erlaubte Werte:
--   Anwahlen, Erreichte Personen, Entscheider, Intro, Short Story,
--   Pitch, Nach Termin gefragt, Termin vereinbart, Nachqualifizierung,
--   An Vorzimmer gescheitert, Setting geführt, Setting Unqualifiziert,
--   No Show, Setting Follow Up, Closing terminiert, Closing geführt,
--   Closing No Show, Closing Follow Up, Folgebesprechung vereinbart,
--   Folgebesprechung No Show, Als Kunden gewonnen, Betrag

-- -------------------------------------------------------------
-- Dashboard-Quoten (für spätere Implementierung):
--
--   1.  Anwahlen zu Termin                  = Termin vereinbart        / Anwahlen
--   2.  Anwahlen zu Erreichte Personen      = Erreichte Personen       / Anwahlen
--   3.  Erreichte Personen zu Entscheider   = Entscheider              / Erreichte Personen
--   4.  Anwahlen zu Entscheider             = Entscheider              / Anwahlen
--   5.  Entscheider zu Termin               = Termin vereinbart        / Entscheider
--   6.  Pitch zu Nach Termin gefragt        = Nach Termin gefragt      / Pitch
--   7.  Setting zu Closing                  = Closing terminiert       / Setting geführt
--   8.  Setting zu Unqualifiziert           = Setting Unqualifiziert   / Setting geführt
--   9.  No Show zu Follow Up                = Setting Follow Up        / No Show
--  10.  Termin vereinbart zu No Show        = No Show                  / Termin vereinbart
--  11.  Closing geführt zu Als Kunden       = Als Kunden gewonnen      / Closing geführt
--  12.  Closing vereinbart zu No Show Rate  = Closing No Show          / Closing terminiert
--  13.  No Show zu Folgebesprechung         = Folgebesprechung vereinbart / No Show
--  14.  No Show zu Follow Up (Closing)      = Closing Follow Up        / Closing No Show
--  15.  Folgebesprechung vereinbart zu NS   = Folgebesprechung No Show / Folgebesprechung vereinbart
-- -------------------------------------------------------------


-- =============================================================
-- Tabelle: tracking_events
-- =============================================================
CREATE TABLE IF NOT EXISTS public.tracking_events (
    id          uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid                     NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    event_type  text                     NOT NULL,
    value       numeric                  NOT NULL DEFAULT 1,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT tracking_events_event_type_check CHECK (
        event_type IN (
            'Anwahlen',
            'Erreichte Personen',
            'Entscheider',
            'Intro',
            'Short Story',
            'Pitch',
            'Nach Termin gefragt',
            'Termin vereinbart',
            'Nachqualifizierung',
            'An Vorzimmer gescheitert',
            'Setting geführt',
            'Setting Unqualifiziert',
            'No Show',
            'Setting Follow Up',
            'Closing terminiert',
            'Closing geführt',
            'Closing No Show',
            'Closing Follow Up',
            'Folgebesprechung vereinbart',
            'Folgebesprechung No Show',
            'Als Kunden gewonnen',
            'Betrag'
        )
    )
);


-- =============================================================
-- Row Level Security (RLS)
-- =============================================================
ALTER TABLE public.tracking_events ENABLE ROW LEVEL SECURITY;

-- Nutzer darf nur eigene Zeilen lesen
CREATE POLICY "Eigene Events lesen"
    ON public.tracking_events
    FOR SELECT
    USING (auth.uid() = user_id);

-- Nutzer darf nur Zeilen mit seiner eigenen user_id einfügen
CREATE POLICY "Eigene Events einfügen"
    ON public.tracking_events
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);


-- =============================================================
-- Index für schnelle Abfragen pro Nutzer & Zeitraum
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_tracking_events_user_created
    ON public.tracking_events (user_id, created_at DESC);
