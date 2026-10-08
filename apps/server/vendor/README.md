# vendor

Third-party binaries the server loads at run time.

## LibFT4222-64.dll

FTDI's library for the FT4222 USB-to-SPI bridge, through which the FT-710 sends its spectrum
scope. The server needs it to show the scope; without it everything else still works and the
scope reports itself as unavailable.

The copy here is version 1.4.8 of the 64-bit Windows library, as downloaded from FTDI's FT4222H
page, <https://ftdichip.com/software-examples/ft4222h-software-examples/>. A genuine copy
carries a valid digital signature from "Future Technology Devices International Ltd" (file
properties → Digital Signatures); this one's SHA-256 is
`9b9e381e87b44084e03eb9d22d1c87a5f9edbaaeed897e749031506307c390b5`.

It is distributed under FTDI's driver licence terms, `FTDI-LICENCE.txt` beside it: FTDI's
libraries may be distributed in any form as long as the licence information is not modified,
and may be used only with products based on FTDI parts. The FT-710's scope port is an FT4222.
Keep the licence file with the DLL; the installer ships both.

To use a copy kept somewhere else, point `RADIOBENCH_FT4222_DLL` at it.

The library builds on FTDI's D2XX driver (`ftd2xx.dll`), which Windows installs by itself when
the radio's scope port first appears.
