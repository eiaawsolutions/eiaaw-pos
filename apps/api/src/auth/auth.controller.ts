import { Body, Controller, Ip, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // The source address is passed through for rate limiting. Behind Railway's
  // proxy this is only as trustworthy as `trust proxy`, which is why it is the
  // second counter rather than the only one — the per-identity limit holds
  // whatever the client claims to be.
  @Post('login')
  login(@Body() body: { email: string; password: string }, @Ip() ip: string) {
    return this.auth.login(body?.email, body?.password, ip);
  }

  @Post('pin')
  pinLogin(@Body() body: { pin: string }, @Ip() ip: string) {
    return this.auth.pinLogin(body?.pin, ip);
  }
}
