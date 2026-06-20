import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    if (request.session && request.session.isAdmin) {
      return true;
    }

    response.redirect('/admin/login');
    return false;
  }
}
