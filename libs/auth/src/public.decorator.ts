import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Allows a bootstrap-authenticated route to use a stamp when one is present. */
export const OPTIONAL_STAMP_KEY = 'optionalStamp';
export const OptionalStamp = () => SetMetadata(OPTIONAL_STAMP_KEY, true);
