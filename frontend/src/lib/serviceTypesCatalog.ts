// AUTO-GENERATED — no editar a mano.
// Fuente: frontend/data/CORREGIDA PLANTILLA-AGENTE-UTOPIA 28 ABRIL.xlsx
// Regenerar: `npm run build:service-types` (desde frontend/).
// Stats: 25 tipos · 70 categorías · 24 tipos con categorías · 10 tipos del catálogo sin categorías.

export interface ServiceTypeOption {
  /** Código del tipo de servicio (ej: "HO", "TO", "TR"). */
  codigo: string;
  /** Descripción libre del tipo (ej: "HOTEL", "TOURS", "TRANSFER"). */
  descripcion: string;
}

export interface CategoryOption {
  /** Código de la categoría (ej: "OCV", "STD", "DLX"). */
  codigo: string;
  /** Descripción humana (ej: "OCEAN VIEW", "STANDARD"). */
  descripcion: string;
}

/**
 * Opciones para columna P (Tipo de Unidad). Convención fija del agente —
 * no viene del xlsx, se hardcodea según las reglas del producto.
 */
export const TIPO_UNIDAD_OPTIONS: ReadonlyArray<{ codigo: "N" | "S"; descripcion: string }> = [
  { codigo: "N", descripcion: "Por noche (hospedajes)" },
  { codigo: "S", descripcion: "Por servicio (tours, transfers, etc.)" },
];

/** Tipos de Servicio (columna Q). Ordenado alfabéticamente por código. */
export const TIPOS_SERVICIO: ReadonlyArray<ServiceTypeOption> = [{"codigo":"AL","descripcion":"MEAL"},{"codigo":"BC","descripcion":"BOAT CHARTER"},{"codigo":"CA","descripcion":"AGENT FEE"},{"codigo":"CT","descripcion":"CREDIT CARD FEE"},{"codigo":"FD","descripcion":"FLEXI DRIVE"},{"codigo":"FT","descripcion":"FLEXI TOURS"},{"codigo":"GI","descripcion":"GIFTS"},{"codigo":"GU","descripcion":"GUIDE"},{"codigo":"HO","descripcion":"HOTEL"},{"codigo":"ND","descripcion":"NO INVOICE"},{"codigo":"OT","descripcion":"OTHER"},{"codigo":"PA","descripcion":"PACKAGE"},{"codigo":"RE","descripcion":"RENT A CAR"},{"codigo":"SE","descripcion":"ST ENTRADAS"},{"codigo":"SH","descripcion":"ST HOSPEDAJE"},{"codigo":"SP","descripcion":"ST PIC NIC"},{"codigo":"SS","descripcion":"ST SERVICIOS PROPIOS"},{"codigo":"ST","descripcion":"SAFARI TOUR - CHOFER"},{"codigo":"SV","descripcion":"ST VIATICOS"},{"codigo":"TA","descripcion":"FLIGHT"},{"codigo":"TO","descripcion":"TOURS"},{"codigo":"TR","descripcion":"TRANSFER"},{"codigo":"TX","descripcion":"AIRPORT TAX"},{"codigo":"VS","descripcion":"VISITS"},{"codigo":"VT","descripcion":"TRAVEL EXPENSES"}];

/**
 * Categorías (columna R) agrupadas por código de Tipo de Servicio.
 * Para mostrar las categorías de un tipo, indexar por su `codigo`. La
 * categoría "UNI" (UNIDADES) aparece al final del array de cada tipo —
 * es el fallback genérico.
 */
export const CATEGORIAS_BY_TIPO_SERVICIO: Readonly<Record<string, ReadonlyArray<CategoryOption>>> = {"AL":[{"codigo":"UNI","descripcion":"UNIDADES"}],"BC":[{"codigo":"UNI","descripcion":"UNIDADES"}],"CO":[{"codigo":"UNI","descripcion":"UNIDADES"}],"EN":[{"codigo":"UNI","descripcion":"UNIDADES"}],"EX":[{"codigo":"UNI","descripcion":"UNIDADES"}],"FC":[{"codigo":"UNI","descripcion":"UNIDADES"}],"FT":[{"codigo":"UNI","descripcion":"FOTOGRAFO"}],"GI":[{"codigo":"UNI","descripcion":"UNIDADES"}],"GU":[{"codigo":"UNI","descripcion":"UNIDADES"}],"HO":[{"codigo":"APT","descripcion":"APARTMENT"},{"codigo":"BUN","descripcion":"BOUNGALOW"},{"codigo":"CAB","descripcion":"CABINA"},{"codigo":"CAS","descripcion":"CASITA"},{"codigo":"CHA","descripcion":"CHALET"},{"codigo":"CON","descripcion":"CONDOMINIO"},{"codigo":"DLX","descripcion":"DELUXE"},{"codigo":"EST","descripcion":"ESTUDIO"},{"codigo":"EXE","descripcion":"EXECUTIVE"},{"codigo":"FAM","descripcion":"FAMILY ROOM"},{"codigo":"HON","descripcion":"HONEYMOON"},{"codigo":"HOU","descripcion":"CASA"},{"codigo":"JUN","descripcion":"JUNIOR SUITE"},{"codigo":"LUX","descripcion":"LUXURI"},{"codigo":"MAS","descripcion":"MASTER SUITE"},{"codigo":"OBS","descripcion":"ONE BED SUITE"},{"codigo":"OCV","descripcion":"OCEAN VIEW"},{"codigo":"PNT","descripcion":"PENTHHOUSE"},{"codigo":"POV","descripcion":"POOL VIEW"},{"codigo":"PRE","descripcion":"PRESIDENTIAL"},{"codigo":"PRM","descripcion":"PREMIUM"},{"codigo":"PRS","descripcion":"PREMIUM SUITE"},{"codigo":"STD","descripcion":"STANDARD"},{"codigo":"SUI","descripcion":"SUITE"},{"codigo":"SUP","descripcion":"SUPERIOR"},{"codigo":"TBS","descripcion":"TWO BEDS SUITE"},{"codigo":"VIL","descripcion":"VILLA"},{"codigo":"UNI","descripcion":"UNIDADES"}],"MU":[{"codigo":"UNI","descripcion":"UNIDADES"}],"ND":[{"codigo":"UNI","descripcion":"UNIDADES"}],"OT":[{"codigo":"UNI","descripcion":"UNIDADES"}],"OV":[{"codigo":"STD","descripcion":"STANDARD"},{"codigo":"UNI","descripcion":"UNIDADES"}],"PA":[{"codigo":"UNI","descripcion":"UNIDADES"}],"PR":[{"codigo":"UNI","descripcion":"UNIDADES"}],"RE":[{"codigo":"4X4","descripcion":"4x4"},{"codigo":"COMP","descripcion":"COMPACT"},{"codigo":"FULL","descripcion":"FULL"},{"codigo":"INTE","descripcion":"INTERMEDIATE"},{"codigo":"PICK","descripcion":"PICK UP"},{"codigo":"PREM","descripcion":"PREMIUM"},{"codigo":"SEDA","descripcion":"SEDAN"},{"codigo":"VAN","descripcion":"VAN"},{"codigo":"UNI","descripcion":"UNIDADES"}],"SF":[{"codigo":"UNI","descripcion":"UNIDADES"}],"SV":[{"codigo":"UNI","descripcion":"UNIDADES"}],"TA":[{"codigo":"UNI","descripcion":"UNIDADES"}],"TO":[{"codigo":"UNI","descripcion":"UNIDADES"}],"TR":[{"codigo":"BST","descripcion":"BUSETA"},{"codigo":"BUS","descripcion":"BUS"},{"codigo":"COA","descripcion":"COASTER"},{"codigo":"CTY","descripcion":"COUNTY"},{"codigo":"HIA","descripcion":"HIACE"},{"codigo":"LAN","descripcion":"LAND CRUISER"},{"codigo":"PRA","descripcion":"PRADO"},{"codigo":"ROS","descripcion":"ROSA"},{"codigo":"SEN","descripcion":"SENIOR"},{"codigo":"SPR","descripcion":"SPRINTER"},{"codigo":"UNI","descripcion":"UNIDADES"}],"VT":[{"codigo":"UNI","descripcion":"UNIDADES"}],"VU":[{"codigo":"UNI","descripcion":"UNIDADES"}]};
